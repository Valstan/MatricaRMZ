// Прямой движок ИИваныча (D-024): сервер сам отвечает на вопросы ai_chat_requests
// через API нейросети, без облачной рутины. Вопрос приезжает push'ем клиента, воркер
// подхватывает его в ближайший тик (2 с), помечает `processing` — клиент видит
// «ИИваныч думает» — и пишет ответ тем же ledger-путём, что писала рутина.
//
// Почему воркер, а не обработка прямо в push-транзакции: ответ идёт минуты и ходит
// в БД тулами, держать на нём транзакцию синка нельзя. Фоновые джобы крутятся только
// на primary-инстансе (shouldRunBackgroundJobs), поэтому гонки двух воркеров нет;
// внутрипроцессная защита — единственный тик в полёте плюс реклейм зависших строк.
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';

import { getEffectivePermissionsForUser } from '../../auth/permissions.js';
import { db } from '../../database/db.js';
import { aiChatMeta, aiChatRequests } from '../../database/schema.js';
import { describeError, logError, logInfo } from '../../utils/logger.js';
import {
  getAiChatActor,
  notifySuperadminEscalation,
  nowMs,
  personLabelForLogin,
  questionFileHref,
  uploadAnswerBuffer,
  writeAiChatRow,
  type AiChatActor,
} from './aiChatWriteService.js';
import { AI_ENABLED, AI_MODEL_ANALYTICS, truncate } from './common.js';
import {
  callLlmWithTools,
  getLlmProvider,
  isLlmConfigured,
  isLlmMisconfigured,
  type LlmToolDef,
  type LlmToolUse,
  type SystemBlock,
} from './llmProvider.js';
import { FULL_TOOL_NAMES, executeTool, getToolDefinitions, type ToolContext } from './llmTools.js';
import { buildAnswerWorkbook, type AnswerTable } from './answerWorkbook.js';
import { buildAnswerDocx } from './answerDocument.js';
import { appendLearningNote, getLearningNotes } from './aiChatLearningNotes.js';

const TICK_MS = Math.max(500, Number(process.env.AI_CHAT_DIRECT_TICK_MS ?? 2_000));
/** Строка зависла в `processing` (рестарт сервера посреди ответа) — вернуть в очередь. */
const STALE_PROCESSING_MS = Math.max(60_000, Number(process.env.AI_CHAT_DIRECT_STALE_MS ?? 10 * 60_000));
const ANSWER_TIMEOUT_MS = Math.max(30_000, Number(process.env.AI_CHAT_ANSWER_TIMEOUT_MS ?? 5 * 60_000));
const ANSWER_MAX_TOKENS = Math.max(512, Number(process.env.AI_CHAT_ANSWER_MAX_TOKENS ?? 4_000));
// Потолок 12 — жёсткий (MAX_TOOL_STEPS в llmProvider). Дефолт поднят 10 → 12
// после кейса владельца 2026-08-17: сводка по договору обрывалась на «выборка
// не завершилась из-за исчерпания лимита обращений к инструментам», причём
// половину шагов съедали безрезультатные поиски. Оборванный ответ всё равно
// стоит полного набора токенов и вынуждает переспрашивать — то есть экономии
// на низком дефолте не было.
const ANSWER_MAX_STEPS = Math.max(1, Math.min(Number(process.env.AI_CHAT_ANSWER_MAX_STEPS ?? 12), 12));
/** Текстовое вложение к вопросу инлайнится в промпт — картинки/офис движок не читает. */
const INLINE_FILE_MAX_BYTES = 200_000;
const INLINE_FILE_EXTENSIONS = ['.txt', '.csv', '.md', '.json', '.log', '.xml', '.yaml', '.yml'];

const ESCALATE_TOOL: LlmToolDef = {
  name: 'escalate_to_admin',
  description:
    'Передать вопрос администратору, когда ответить нельзя: не хватает прав или данных в базе, ' +
    'вопрос вне программы, требуется управленческое решение. Вызывай вместо выдуманного ответа.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Чего не хватает для ответа — одной-двумя фразами.' },
    },
    required: ['reason'],
  },
};

const ATTACH_TABLE_TOOL: LlmToolDef = {
  name: 'attach_table',
  description:
    'Приложить к ответу файл Excel (.xlsx) с таблицей. Вызывай, когда пользователь просит ответ файлом ' +
    'или таблица длиннее ~15 строк. Один вызов — один лист. После вызова всё равно дай короткий текстовый вывод.',
  input_schema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Имя файла без расширения, по-русски, коротко.' },
      columns: { type: 'array', items: { type: 'string' }, description: 'Заголовки колонок.' },
      rows: {
        type: 'array',
        description: 'Строки таблицы: массив массивов значений в порядке колонок.',
        items: { type: 'array', items: { type: 'string' } },
      },
    },
    required: ['filename', 'columns', 'rows'],
  },
};

const BASE_PROMPT =
  'Ты ИИваныч — помощник работников ремонтно-механического завода в ERP-программе «Матрица РМЗ». ' +
  'Отвечай по-русски, по делу, без воды: сначала прямой ответ, затем при необходимости пояснение. ' +
  'Данные бери ТОЛЬКО из tools (read-only доступ к базе) — не выдумывай числа, названия и функции программы. ' +
  'Пользователи пишут неточно: сокращённые названия, опечатки, внутренний жаргон. ' +
  'Прежде чем сказать «не найдено / не существует» — ОБЯЗАТЕЛЬНО поищи через find_entity (нечёткий поиск). ' +
  'Если запрос неоднозначен или кандидатов несколько — задай пользователю короткий уточняющий вопрос ' +
  'обычным ответом (перечисли найденные варианты); его следующее сообщение придёт с контекстом этого диалога. ' +
  'Когда уточнение раскрыло, что пользователь имел в виду (синоним, сокращение, где лежат данные) — ' +
  'сохрани это одной фразой через save_learning_note, чтобы в следующий раз не переспрашивать. ' +
  'Если данных для точного ответа нет или прав пользователя не хватает — вызови escalate_to_admin, а не гадай. ' +
  'Ответ оформляй простым markdown (заголовки, списки, таблицы до ~15 строк). ' +
  'Длинные таблицы отдавай файлом через attach_table. ' +
  'К каждому текстовому ответу сервер сам прикладывает документ Word — отдельно собирать его не нужно.';

const SAVE_LEARNING_NOTE_TOOL: LlmToolDef = {
  name: 'save_learning_note',
  description:
    'Сохранить короткую заметку самообучения: как понимать пользователей в будущем. ' +
    'Примеры: «ОВК = заказчик ООО "ОВК" (тип customer)», «рекламации ищи через get_reclamations». ' +
    'Вызывай после успешного уточнения или когда обнаружил неочевидное соответствие. Одна фраза, без воды.',
  input_schema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Одна короткая фраза-правило.' },
    },
    required: ['note'],
  },
};

const MAX_ATTEMPTS = Math.max(1, Number(process.env.AI_CHAT_ANSWER_MAX_ATTEMPTS ?? 3));

let running = false;
let timer: NodeJS.Timeout | null = null;
const inFlight = new Set<string>();
/** Счётчик неудач на вопрос — чтобы вечно падающий вопрос не крутился в цикле. */
const attempts = new Map<string, number>();

async function getRulesMd(): Promise<string | null> {
  const rows = await db.select().from(aiChatMeta).where(eq(aiChatMeta.key, 'rules_md')).limit(1);
  const value = rows[0]?.value ?? null;
  return value && String(value).trim() ? String(value) : null;
}

function isInlineableFile(name: string): boolean {
  const lower = name.toLowerCase();
  return INLINE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Текстовое вложение вопроса — в промпт; всё остальное честно помечаем непрочитанным. */
async function describeQuestionFile(questionFileJson: string | null): Promise<string | null> {
  if (!questionFileJson) return null;
  let name = 'файл';
  let size = 0;
  try {
    const ref = JSON.parse(questionFileJson) as { name?: string; size?: number };
    name = String(ref?.name ?? name);
    size = Number(ref?.size ?? 0);
  } catch {
    return null;
  }
  if (!isInlineableFile(name) || size > INLINE_FILE_MAX_BYTES) {
    return `К вопросу приложен файл «${name}» — прочитать его ты не можешь. Если ответ зависит от содержимого, скажи об этом и попроси прислать данные текстом.`;
  }
  const href = await questionFileHref(questionFileJson).catch(() => null);
  if (!href) return `К вопросу приложен файл «${name}», но скачать его не удалось.`;
  try {
    const resp = await fetch(href);
    if (!resp.ok) return `К вопросу приложен файл «${name}», но скачать его не удалось (HTTP ${resp.status}).`;
    const text = truncate(await resp.text(), 40_000);
    return `Содержимое приложенного файла «${name}»:\n${text}`;
  } catch (e) {
    return `К вопросу приложен файл «${name}», но прочитать его не удалось (${String(e)}).`;
  }
}

function parseAttachTable(input: Record<string, unknown>): AnswerTable | null {
  const columns = Array.isArray(input.columns) ? input.columns.map((c) => String(c ?? '')) : [];
  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  if (columns.length === 0 || rawRows.length === 0) return null;
  const rows = rawRows
    .filter((r): r is unknown[] => Array.isArray(r))
    .map((r) => r.map((v) => (v == null ? '' : String(v))));
  if (rows.length === 0) return null;
  const filename = String(input.filename ?? 'Таблица').trim() || 'Таблица';
  return { filename, columns, rows };
}

/** Забрать вопрос в работу: pending → processing (виден клиенту как «думает»). */
async function claim(row: any, actor: AiChatActor): Promise<boolean> {
  const ts = nowMs();
  const res = await writeAiChatRow(actor, { ...row, status: 'processing', updatedAt: ts });
  if (res.skipped.length > 0) {
    logInfo('ai chat direct: claim skipped', { id: String(row.id), skipped: res.skipped });
    return false;
  }
  return true;
}

async function finish(
  row: any,
  actor: AiChatActor,
  patch: { status: string; answerText?: string | null; answerFilesJson?: string | null; escalationNote?: string | null },
) {
  const ts = nowMs();
  await writeAiChatRow(actor, {
    ...row,
    status: patch.status,
    answerText: patch.answerText ?? null,
    answerFilesJson: patch.answerFilesJson ?? null,
    escalationNote: patch.escalationNote ?? null,
    answeredAt: patch.status === 'answered' || patch.status === 'rejected' ? ts : null,
    updatedAt: ts,
  });
}

const DIALOGUE_WINDOW_MS = 6 * 60 * 60_000;
const DIALOGUE_MAX_TURNS = 3;
const DIALOGUE_TEXT_CAP = 1_200;

/**
 * Последние отвеченные вопросы того же сотрудника — контекст диалога.
 * Без него каждое сообщение — «с чистого листа», и уточняющий вопрос модели
 * («какого именно контрагента?») не может получить осмысленный ответ.
 */
async function recentDialogueForUser(userId: string, excludeRequestId: string): Promise<string | null> {
  const rows = await db
    .select({
      id: aiChatRequests.id,
      questionText: aiChatRequests.questionText,
      answerText: aiChatRequests.answerText,
      answeredAt: aiChatRequests.answeredAt,
    })
    .from(aiChatRequests)
    .where(
      and(
        isNull(aiChatRequests.deletedAt),
        eq(aiChatRequests.userId, userId),
        eq(aiChatRequests.status, 'answered'),
        gt(aiChatRequests.answeredAt, nowMs() - DIALOGUE_WINDOW_MS),
      ),
    )
    .orderBy(desc(aiChatRequests.answeredAt))
    .limit(DIALOGUE_MAX_TURNS + 1);
  const turns = rows
    .filter((r) => String(r.id) !== excludeRequestId && r.answerText)
    .slice(0, DIALOGUE_MAX_TURNS)
    .reverse();
  if (turns.length === 0) return null;
  const cap = (t: string) => (t.length > DIALOGUE_TEXT_CAP ? `${t.slice(0, DIALOGUE_TEXT_CAP)}…` : t);
  return turns
    .map((t) => `Сотрудник: ${cap(String(t.questionText))}\nИИваныч: ${cap(String(t.answerText))}`)
    .join('\n---\n');
}

async function answerOne(row: any, actor: AiChatActor): Promise<void> {
  const requestId = String(row.id);
  const userId = String(row.userId);
  const permissions = await getEffectivePermissionsForUser(userId);
  const toolCtx: ToolContext = { actorId: userId, permissions };
  const rulesMd = await getRulesMd();
  const fileBlock = await describeQuestionFile(row.questionFileJson ?? null);

  const systemBlocks: SystemBlock[] = [{ type: 'text', text: BASE_PROMPT }];
  if (rulesMd) systemBlocks.push({ type: 'text', text: `Правила ответов, заданные администратором:\n${rulesMd}` });
  const learningMd = await getLearningNotes().catch(() => null);
  if (learningMd) {
    systemBlocks.push({
      type: 'text',
      text: `Твои накопленные заметки о том, как понимать пользователей (самообучение):\n${learningMd}`,
    });
  }
  if (row.verdictText) {
    systemBlocks.push({
      type: 'text',
      text: `Администратор дал вердикт по этому вопросу — отвечай в соответствии с ним:\n${String(row.verdictText)}`,
    });
  }

  const personLabel = await personLabelForLogin(String(row.username));
  // Недавний диалог того же сотрудника — контекст для уточняющих вопросов:
  // «какого именно?» → следующее сообщение пользователя должно пониматься
  // как ответ на уточнение, а не как вопрос с чистого листа.
  const recent = await recentDialogueForUser(userId, requestId);
  const userMessage = [
    ...(recent ? [`Недавний диалог с этим сотрудником (для контекста):\n${recent}`, ''] : []),
    `Вопрос сотрудника ${personLabel}:`,
    String(row.questionText),
    ...(fileBlock ? ['', fileBlock] : []),
  ].join('\n');

  const tables: AnswerTable[] = [];
  let escalationReason: string | null = null;

  const result = await callLlmWithTools({
    model: AI_MODEL_ANALYTICS,
    systemBlocks,
    userMessage,
    tools: [...getToolDefinitions(FULL_TOOL_NAMES), ESCALATE_TOOL, ATTACH_TABLE_TOOL, SAVE_LEARNING_NOTE_TOOL],
    options: { timeoutMs: ANSWER_TIMEOUT_MS, maxTokens: ANSWER_MAX_TOKENS, temperature: 0.2 },
    maxSteps: ANSWER_MAX_STEPS,
    executeTool: async (toolUse: LlmToolUse) => {
      if (toolUse.name === ESCALATE_TOOL.name) {
        escalationReason = String(toolUse.input?.reason ?? '').trim() || 'причина не указана';
        return { content: 'Вопрос передан администратору. Заверши ответ короткой фразой об этом.' };
      }
      if (toolUse.name === SAVE_LEARNING_NOTE_TOOL.name) {
        const res = await appendLearningNote(String(toolUse.input?.note ?? ''));
        return res.ok
          ? { content: 'Заметка сохранена.' }
          : { content: `Заметка не сохранена: ${res.error}`, isError: true };
      }
      if (toolUse.name === ATTACH_TABLE_TOOL.name) {
        const table = parseAttachTable(toolUse.input ?? {});
        if (!table) return { content: 'Таблица пустая — заполни columns и rows.', isError: true };
        tables.push(table);
        return { content: `Файл «${table.filename}.xlsx» приложен к ответу (${table.rows.length} строк).` };
      }
      return executeTool(toolUse, toolCtx);
    },
  });

  if (escalationReason) {
    await finish(row, actor, { status: 'escalated', escalationNote: escalationReason });
    await notifySuperadminEscalation(actor, {
      username: String(row.username),
      questionText: String(row.questionText),
      reason: escalationReason,
    }).catch((e) => logError('ai chat direct: superadmin DM failed', { id: requestId, error: String(e) }));
    logInfo('ai chat direct: escalated', { id: requestId, reason: escalationReason });
    return;
  }

  const answerText = result.text.trim();
  if (!answerText) {
    await finish(row, actor, {
      status: 'escalated',
      escalationNote: 'Движок вернул пустой ответ (исчерпаны шаги или лимит токенов).',
    });
    // Имена вызванных tools показывают, на чём именно закольцевался ответ.
    logError('ai chat direct: empty answer', {
      id: requestId,
      steps: result.steps,
      stopReason: result.stopReason,
      tools: result.toolUses.map((t) => t.name).join(','),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    return;
  }

  const attachRefs: Record<string, unknown>[] = [];
  for (const table of tables) {
    try {
      const bytes = await buildAnswerWorkbook(table);
      attachRefs.push(await uploadAnswerBuffer(requestId, `${table.filename}.xlsx`, bytes, actor.id));
    } catch (e) {
      logError('ai chat direct: attachment failed', { id: requestId, error: String(e) });
    }
  }
  // По умолчанию ответ дублируется документом Word (решение владельца 2026-08-17):
  // пользователь открывает, правит и печатает. Если модель уже приложила файл
  // (пользователь выбрал другой формат, напр. Excel) — docx не дублируем.
  if (attachRefs.length === 0) {
    try {
      const bytes = await buildAnswerDocx({ question: String(row.questionText ?? ''), answerMarkdown: answerText });
      attachRefs.push(await uploadAnswerBuffer(requestId, 'Ответ ИИваныча.docx', bytes, actor.id));
    } catch (e) {
      logError('ai chat direct: docx attachment failed', { id: requestId, error: String(e) });
    }
  }

  await finish(row, actor, {
    status: 'answered',
    answerText,
    answerFilesJson: attachRefs.length > 0 ? JSON.stringify(attachRefs) : null,
  });
  logInfo('ai chat direct: answered', {
    id: requestId,
    steps: result.steps,
    tools: result.toolUses.length,
    attachments: attachRefs.length,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
}

/** Строки, застрявшие в `processing` после рестарта, — обратно в очередь. */
async function reclaimStale(actor: AiChatActor): Promise<void> {
  const rows = await db
    .select()
    .from(aiChatRequests)
    .where(
      and(
        isNull(aiChatRequests.deletedAt),
        eq(aiChatRequests.status, 'processing'),
        lt(aiChatRequests.updatedAt, nowMs() - STALE_PROCESSING_MS),
      ),
    )
    .limit(20);
  for (const row of rows as any[]) {
    if (inFlight.has(String(row.id))) continue;
    logInfo('ai chat direct: reclaiming stale request', { id: String(row.id) });
    await writeAiChatRow(actor, { ...row, status: 'pending', updatedAt: nowMs() });
  }
}

/** Новые вопросы + эскалированные, по которым суперадмин уже дал вердикт. */
async function listPending(): Promise<any[]> {
  return (await db
    .select()
    .from(aiChatRequests)
    .where(
      and(
        isNull(aiChatRequests.deletedAt),
        or(
          eq(aiChatRequests.status, 'pending'),
          and(eq(aiChatRequests.status, 'escalated'), isNotNull(aiChatRequests.verdictText)),
        ),
      ),
    )
    .orderBy(asc(aiChatRequests.createdAt))
    .limit(20)) as any[];
}

/** Один проход очереди. Экспортируется для тестов и ручного прогона. */
export async function aiChatDirectTick(): Promise<{ processed: number }> {
  if (!AI_ENABLED || !isLlmConfigured()) return { processed: 0 };
  const actor = await getAiChatActor();
  await reclaimStale(actor).catch((e) => logError('ai chat direct: reclaim failed', { error: String(e) }));

  let processed = 0;
  for (const row of await listPending()) {
    const id = String(row.id);
    if (inFlight.has(id)) continue;
    if (!(await claim(row, actor))) continue;
    inFlight.add(id);
    try {
      await answerOne({ ...row, status: 'processing' }, actor);
      attempts.delete(id);
      processed += 1;
    } catch (e) {
      const misconfigured = isLlmMisconfigured(e);
      const failed = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, failed);
      logError('ai chat direct: answer failed', { id, attempt: failed, error: String(e), misconfigured });
      if (failed >= MAX_ATTEMPTS && !misconfigured) {
        // Дальше молотить бессмысленно — отдаём человеку, а не крутим цикл.
        attempts.delete(id);
        await finish(row, actor, {
          status: 'escalated',
          escalationNote: `Технический сбой движка (${MAX_ATTEMPTS} попытки): ${truncate(String(e), 300)}`,
        }).catch(() => undefined);
        await notifySuperadminEscalation(actor, {
          username: String(row.username),
          questionText: String(row.questionText),
          reason: 'ИИваныч не смог ответить из-за технической ошибки — нужен взгляд администратора.',
        }).catch(() => undefined);
      } else {
        // Возвращаем строку в исходный статус: следующий тик повторит попытку.
        await writeAiChatRow(actor, { ...row, updatedAt: nowMs() }).catch(() => undefined);
      }
      if (misconfigured) break;
    } finally {
      inFlight.delete(id);
    }
  }
  return { processed };
}

export function startAiChatDirectWorker(): void {
  if (timer) return;
  if (!AI_ENABLED) {
    logInfo('ai chat direct worker: disabled (AI_ENABLED=false)');
    return;
  }
  if (!isLlmConfigured()) {
    logError('ai chat direct worker: LLM key missing — questions will queue until it is configured');
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await aiChatDirectTick();
    } catch (e) {
      logError('ai chat direct worker tick failed', describeError(e));
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  // critical:true — иначе на проде строки не будет вовсе (logger режет info вне dev),
  // и после деплоя нечем подтвердить, что движок вообще поднялся.
  logInfo(
    'ai chat direct worker started',
    { tickMs: TICK_MS, model: AI_MODEL_ANALYTICS, provider: getLlmProvider(), keyConfigured: isLlmConfigured() },
    { critical: true },
  );
}
