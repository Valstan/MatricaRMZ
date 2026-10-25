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

vi.mock('./serverEngine.js', () => ({
  askServerEngine: async () => ({ ok: false, kind: 'unavailable', error: 'движок в паузе' }),
  isServerEngineEnabled: () => true,
  isServerEngineAvailable: () => true,
}));

vi.mock('./llmProvider.js', () => ({
  callLlmWithTools: async () => {
    llmCalls += 1;
    throw new Error('402 {"error":{"message":"Insufficient Balance","type":"insufficient_balance_error"}}');
  },
  callLlm: async () => {
    throw new Error('402 Insufficient Balance');
  },
  getLlmProvider: () => 'deepseek',
  isLlmConfigured: () => true,
  isLlmMisconfigured: () => false,
}));

vi.mock('./llmTools.js', () => ({
  FULL_TOOL_NAMES: [] as string[],
  executeTool: async () => null,
  getToolDefinitions: () => [],
}));

vi.mock('./iivanychTools.js', () => ({
  IIVANYCH_TOOLS: [],
  runIivanychTool: async () => null,
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
  it('счёт резервного движка на нуле — после MAX_ATTEMPTS вопрос уходит человеку', async () => {
    process.env.AI_CHAT_ANSWER_MAX_ATTEMPTS = '3';
    const service = await loadService();

    for (let i = 0; i < 3; i += 1) await service.aiChatDirectTick();

    expect(llmCalls).toBe(3);
    const statuses = writtenRows.map((w) => w.row.status);
    expect(statuses.filter((s) => s === 'escalated')).toHaveLength(1);
    const row = requestRows[0];
    expect(row?.status).toBe('escalated');
    expect(String(row?.escalationNote)).toContain('резервного движка на нуле');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.questionText).toContain('Сколько двигателей');
  });
});
