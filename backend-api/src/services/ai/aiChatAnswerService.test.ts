// Сторож очереди прямого движка: вопрос не должен крутиться вечно.
//
// 25.10 на проде строка висела с 11:38 в `pending`: движок не ответил, DeepSeek
// вернул 402, а в ветке «счёт кончился» код делал `attempts.delete` — счётчик
// неудач обнулялся, эскалация не наступала никогда, и владельцу не приходило
// ничего. Тест держит именно это: после MAX_ATTEMPTS строка уходит человеку.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const metaStore = new Map<string, string>();
let requestRows: Array<Record<string, any>> = [];
const writtenRows: Array<{ row: any }> = [];
const escalations: Array<{ username: string; questionText: string; reason?: string }> = [];
let llmCalls = 0;
let probeCalls = 0;
/** Проба баланса отвечает «живой» — иначе воркер после 402 перестаёт брать вопросы. */
let probeAlive = false;
/** Ответ провайдера удачный (без 402) — для проверок, где важен сам запрос. */
let llmSucceeds = false;
/** Аргументы последних вызовов модели — по ним проверяем стабильность префикса (R29). */
const llmArgs: Array<{ systemBlocks: Array<{ text: string }>; userMessage: string }> = [];
/** Имена инструментов, которые модель видела на каждом шаге (меню перечитывается). */
const offeredTools: string[][] = [];
/** Модель сама просит расширенный набор инструментов (enable_full_tools). */
let modelExpandsTools = false;

/** Меню, объявленное в запросе: массив или функция (набор может расширяться). */
function offeredNames(tools: any): string[] {
  const list = typeof tools === 'function' ? tools() : tools;
  return (list ?? []).map((t: any) => t.name);
}

function col(key: string) {
  return { key };
}

vi.mock('drizzle-orm', () => ({
  and: (...preds: any[]) => (row: any) => preds.every((p) => (typeof p === 'function' ? p(row) : true)),
  or: (...preds: any[]) => (row: any) => preds.some((p) => (typeof p === 'function' ? p(row) : true)),
  eq: (c: any, v: any) => (row: any) => row[c.key] === v,
  isNull: (c: any) => (row: any) => row[c.key] == null,
  isNotNull: (c: any) => (row: any) => row[c.key] != null,
  lt: (c: any, v: any) => (row: any) => Number(row[c.key] ?? 0) < Number(v),
  gt: (c: any, v: any) => (row: any) => Number(row[c.key] ?? 0) > Number(v),
  asc: (c: any) => ({ key: c.key, dir: 'asc' as const }),
  desc: (c: any) => ({ key: c.key, dir: 'desc' as const }),
}));

vi.mock('../../database/schema.js', () => ({
  aiChatMeta: { key: col('key'), value: col('value'), updatedAt: col('updatedAt') },
  aiChatRequests: {
    id: col('id'),
    userId: col('userId'),
    username: col('username'),
    questionText: col('questionText'),
    questionFileJson: col('questionFileJson'),
    status: col('status'),
    answerText: col('answerText'),
    answeredAt: col('answeredAt'),
    verdictText: col('verdictText'),
    createdAt: col('createdAt'),
    updatedAt: col('updatedAt'),
    deletedAt: col('deletedAt'),
  },
}));

vi.mock('../../database/db.js', () => {
  function selectChain(table: any) {
    const state: { whereFn?: (r: any) => boolean; orderKey?: string; orderDir?: string; limitN?: number } = {};
    const exec = () => {
      if (table.value !== undefined) return [...metaStore].map(([key, value]) => ({ key, value }));
      let rows = requestRows.filter((r) => !state.whereFn || state.whereFn(r));
      if (state.orderKey) {
        const key = state.orderKey;
        rows = [...rows].sort((a, b) =>
          state.orderDir === 'desc' ? Number(b[key] ?? 0) - Number(a[key] ?? 0) : Number(a[key] ?? 0) - Number(b[key] ?? 0),
        );
      }
      return typeof state.limitN === 'number' ? rows.slice(0, state.limitN) : rows;
    };
    const chain: any = {
      from: () => chain,
      where: (fn: any) => {
        state.whereFn = fn;
        return chain;
      },
      orderBy: (o: any) => {
        state.orderKey = o?.key;
        state.orderDir = o?.dir;
        return chain;
      },
      limit: (n: number) => {
        state.limitN = n;
        return Promise.resolve(exec());
      },
      then: (resolve: any) => Promise.resolve(exec()).then(resolve),
    };
    return chain;
  }
  return { db: { select: () => ({ from: (table: any) => selectChain(table) }) } };
});

vi.mock('./aiChatWriteService.js', () => ({
  nowMs: () => Date.now(),
  getAiChatActor: async () => ({ id: 'actor-1', username: 'ai-agent', role: 'admin' }),
  personLabelForLogin: async (login: string) => login,
  questionFileHref: () => 'http://files.test/x',
  uploadAnswerBuffer: async () => ({ name: 'x' }),
  notifySuperadminEscalation: async (_actor: any, payload: any) => {
    escalations.push(payload);
  },
  writeAiChatRow: async (_actor: any, row: any) => {
    writtenRows.push({ row });
    const i = requestRows.findIndex((r) => r.id === row.id);
    if (i >= 0) requestRows[i] = { ...requestRows[i], ...row };
    return { skipped: [] as string[] };
  },
}));

vi.mock('./llmProvider.js', () => ({
  callLlmWithTools: async (args: any) => {
    llmCalls += 1;
    llmArgs.push({ systemBlocks: args.systemBlocks, userMessage: args.userMessage });
    offeredTools.push(offeredNames(args.tools));
    if (llmSucceeds) {
      if (modelExpandsTools) {
        // Модель позвала enable_full_tools — путь ответа обязан расширить меню,
        // иначе следующий шаг уйдёт с компактным набором и нужный инструмент
        // модель не увидит.
        await args.executeTool({ id: 'tu-1', name: 'enable_full_tools', input: { reason: 'нужен аналитический отчёт' } });
        offeredTools.push(offeredNames(args.tools));
      }
      return {
        text: 'ответ модели',
        toolUses: [],
        steps: 1,
        inputTokens: 12,
        outputTokens: 7,
        cacheReadTokens: 8,
        cacheCreationTokens: 0,
        stopReason: 'end_turn',
      };
    }
    throw new Error('402 {"error":{"message":"Insufficient Balance","type":"insufficient_balance_error"}}');
  },
  callLlm: async () => {
    probeCalls += 1;
    if (probeAlive) return 'счёт живой';
    throw new Error('402 Insufficient Balance');
  },
  getLlmProvider: () => 'deepseek',
  isLlmConfigured: () => true,
  isLlmMisconfigured: () => false,
}));

// Зеркало реальных наборов: компактный — обычный вопрос, полный — аналитика.
// Соответствие настоящим спискам проверяет сторож
// `backend-api/src/tests/llmTools.answerCompact.guard.test.ts`.
vi.mock('./llmTools.js', () => ({
  ANSWER_COMPACT_TOOL_NAMES: ['find_entity', 'query_nomenclature', 'suggest_report'] as string[],
  FULL_TOOL_NAMES: [
    'find_entity',
    'query_nomenclature',
    'suggest_report',
    'get_workshop_throughput',
  ] as string[],
  executeTool: async () => null,
  getToolDefinitions: (names: ReadonlyArray<string>) =>
    names.map((name) => ({ name, description: '', input_schema: { type: 'object' as const, properties: {} } })),
}));

vi.mock('./iivanychTools.js', () => ({
  IIVANYCH_TOOLS: [
    { name: 'escalate_to_admin', description: '', input_schema: { type: 'object' as const, properties: {} } },
    { name: 'save_learning_note', description: '', input_schema: { type: 'object' as const, properties: {} } },
    { name: 'attach_table', description: '', input_schema: { type: 'object' as const, properties: {} } },
    { name: 'enable_full_tools', description: '', input_schema: { type: 'object' as const, properties: {} } },
  ],
  runIivanychTool: async (toolUse: any, side: any) => {
    if (toolUse?.name === 'enable_full_tools') {
      side.fullToolsEnabled = true;
      return { content: 'Расширенный набор инструментов включён.' };
    }
    return null;
  },
}));

vi.mock('./aiChatLearningNotes.js', () => ({ getLearningNotes: async () => null }));
vi.mock('./answerWorkbook.js', () => ({ buildAnswerWorkbook: async () => Buffer.from('') }));
vi.mock('./answerDocument.js', () => ({ buildAnswerDocx: async () => Buffer.from('') }));
vi.mock('./aiChatHotlineBridgeService.js', () => ({ listBridgedRequestIds: async () => new Set<string>() }));
vi.mock('../../auth/permissions.js', () => ({ getEffectivePermissionsForUser: async () => ({}) }));

async function loadService() {
  vi.resetModules();
  return await import('./aiChatAnswerService.js');
}

beforeEach(() => {
  metaStore.clear();
  writtenRows.length = 0;
  escalations.length = 0;
  llmCalls = 0;
  probeCalls = 0;
  probeAlive = false;
  llmSucceeds = false;
  llmArgs.length = 0;
  offeredTools.length = 0;
  modelExpandsTools = false;
  requestRows = [
    {
      id: 'req-1',
      userId: 'u-1',
      username: 'oper',
      questionText: 'Сколько двигателей на заводе?',
      questionFileJson: null,
      status: 'pending',
      answerText: null,
      verdictText: null,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      deletedAt: null,
    },
  ];
});

describe('очередь прямого движка', () => {
  // 25.10: строка висела в `pending` вечно — счёт кончился, а эскалация не наступала.
  // Теперь звено одно (DeepSeek), и «денег нет» означает «ответ невозможен»: вопрос
  // ждёт пополнения, но после MAX_ATTEMPTS подтверждений уходит человеку.
  it('счёт на нуле — после MAX_ATTEMPTS подтверждений вопрос уходит человеку', async () => {
    vi.useFakeTimers();
    try {
      process.env.AI_CHAT_ANSWER_MAX_ATTEMPTS = '3';
      const service = await loadService();

      await service.aiChatDirectTick();
      expect(llmCalls).toBe(1);

      // Пауза между пробами не вышла — провайдера не дёргаем.
      await service.aiChatDirectTick();
      expect(llmCalls).toBe(1);

      // Проба (5 мин) подтвердила: денег нет. Вторая (10 мин) — уже эскалация.
      vi.advanceTimersByTime(5 * 60_000);
      await service.aiChatDirectTick();
      expect(probeCalls).toBeGreaterThan(0);
      vi.advanceTimersByTime(10 * 60_000);
      await service.aiChatDirectTick();

      const statuses = writtenRows.map((w) => w.row.status);
      expect(statuses.filter((s) => s === 'escalated')).toHaveLength(1);
      const row = requestRows[0];
      expect(row?.status).toBe('escalated');
      expect(String(row?.escalationNote)).toContain('на нуле');
      expect(escalations).toHaveLength(1);
      expect(escalations[0]?.questionText).toContain('Сколько двигателей');
    } finally {
      vi.useRealTimers();
    }
  });

  // Кэш префикса (R29): DeepSeek кэширует НАЧАЛО запроса, и счёт у провайдера платный.
  // Значит system-блоки Ииваныча должны быть одинаковыми от вопроса к вопросу, а всё
  // живое (вопрос, сотрудник, заметки самообучения, вердикт) — в user-сообщении.
  // Иначе кэш обнуляется на каждом запросе и деньги сгорают впустую.
  it('система Ииваныча одинакова от вопроса к вопросу — префикс кэшируется', async () => {
    process.env.AI_CHAT_ANSWER_MAX_ATTEMPTS = '3';
    llmSucceeds = true;
    const service = await loadService();

    await service.aiChatDirectTick();
    // Проба баланса после 402 обязана пройти, иначе второй вопрос не возьмут.
    probeAlive = true;
    requestRows = [
      {
        id: 'req-2',
        userId: 'u-2',
        username: 'master',
        questionText: 'Какой график ППО за прошлый месяц?',
        questionFileJson: null,
        status: 'pending',
        answerText: null,
        verdictText: null,
        createdAt: Date.now() - 30_000,
        updatedAt: Date.now() - 30_000,
        deletedAt: null,
      },
    ];
    await service.aiChatDirectTick();

    expect(llmArgs.length).toBeGreaterThanOrEqual(2);
    const first = llmArgs[0]!;
    const second = llmArgs[llmArgs.length - 1]!;
    const system1 = first.systemBlocks.map((b) => b.text).join('\n\n');
    const system2 = second.systemBlocks.map((b) => b.text).join('\n\n');
    expect(system1).toBe(system2);
    // Ни даты, ни сотрудника в system — иначе префикс обнуляется на каждом запросе.
    expect(system1).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(system1).not.toContain('oper');
    expect(system1).not.toContain('master');
    // Живое — в сообщении.
    expect(second.userMessage).toContain('Какой график ППО');
  });

  // Проба баланса — настоящий запрос к провайдеру. С фиксированным интервалом она
  // молотит в пустоту круглосуточно (25.10: 430 записей `402` за неделю, 12/час и ночью),
  // поэтому пауза обязана расти: 5 мин → 10 → 20 …
  it('при нулевом балансе проба баланса редеет, а не бьёт каждые 5 минут', async () => {
    vi.useFakeTimers();
    try {
      const service = await loadService();
      await service.aiChatDirectTick();
      const afterFirstFailure = probeCalls;

      // Дальше вопросов нет — работает только проба.
      requestRows = [];

      vi.advanceTimersByTime(5 * 60_000);
      await service.aiChatDirectTick();
      expect(probeCalls).toBe(afterFirstFailure + 1);

      // Прошло ещё 5 минут, но пауза после неудачи уже 10 — пробы быть не должно.
      vi.advanceTimersByTime(5 * 60_000);
      await service.aiChatDirectTick();
      expect(probeCalls).toBe(afterFirstFailure + 1);

      vi.advanceTimersByTime(5 * 60_000);
      await service.aiChatDirectTick();
      expect(probeCalls).toBe(afterFirstFailure + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  // 07.11.2026 на проде вопрос «сколько двигателей» занял 12 шагов с инструментами
  // (потолок ANSWER_MAX_STEPS) и ~50 с: модель перебирала меню из 19 инструментов.
  // Ответ стартует с компактного набора — аналитические инструменты в меню не светятся.
  it('ответ стартует с компактного набора инструментов', async () => {
    process.env.AI_CHAT_ANSWER_MAX_ATTEMPTS = '3';
    llmSucceeds = true;
    const service = await loadService();

    await service.aiChatDirectTick();

    expect(offeredTools.length).toBeGreaterThan(0);
    const first = offeredTools[0]!;
    expect(first).toContain('find_entity');
    expect(first).toContain('suggest_report');
    // Аналитика в компактном наборе не лежит — её модель берёт по запросу.
    expect(first).not.toContain('get_workshop_throughput');
  });

  // Компактный старт не должен стоить способности отвечать: модель сама расширяет
  // меню, когда компактного не хватило, и следующий шаг обязан видеть полный набор.
  it('модель включает расширенный набор — следующий шаг видит полный', async () => {
    process.env.AI_CHAT_ANSWER_MAX_ATTEMPTS = '3';
    llmSucceeds = true;
    modelExpandsTools = true;
    const service = await loadService();

    await service.aiChatDirectTick();

    expect(offeredTools.length).toBeGreaterThanOrEqual(2);
    const afterExpand = offeredTools[offeredTools.length - 1]!;
    expect(afterExpand).toContain('get_workshop_throughput');
    expect(afterExpand).toContain('enable_full_tools');
  });

  // Промпт зовёт инструменты поимённо. Инструмента, которого нет в меню, модель не
  // зовёт: она уходит в эскалацию или отвечает «не найдено» там, где всё есть.
  it('каждый инструмент, названный в промпте, есть в меню модели', async () => {
    process.env.AI_CHAT_ANSWER_MAX_ATTEMPTS = '3';
    llmSucceeds = true;
    const service = await loadService();

    await service.aiChatDirectTick();

    const named = service.IIVANYCH_BASE_PROMPT.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    const offered = new Set(offeredTools[0] ?? []);
    for (const name of named) {
      expect(offered.has(name)).toBe(true);
    }
  });
});
