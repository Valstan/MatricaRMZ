// Стенд замера пути ответа Ииваныча.
//
// Зачем: держать Ииваныча под контролем — быстрее, дешевле, без потери качества.
// На проде видно только шаги и набор инструментов (поля `steps` и `toolSet` в журнале
// `ai chat direct: answered`); токены, доля кэша и время живут в логе провайдера.
// Стенд гоняет те же вопросы через ТОТ ЖЕ код (тот же промпт, то же меню, тот же
// вызов) и печатает всё вместе — чтобы менять настройки (размер меню, потолок шагов,
// глубину промпта) и видеть последствия до того, как они поедут на прод.
//
// Ключ DeepSeek берётся из комнаты КАРМАНА на лету — в репозитории его нет, и
// класть его в репозиторий нельзя (репо публичный). Адрес хранилища — из
// `SECRETS_VAULT_URL` или из локального файла рядом с токеном (`~/.matricarmz-keys/vault-url`);
// сам адрес в публичный репо не пишем (см. brain_matrica/docs/KARMAN_ROOM.md).
//
// Нужна база: локальный dev-PG (см. docs/machines/PC79.md) — прод для замеров не
// трогаем, стенд и есть «стенд».
//
// Запуск:
//   corepack pnpm -F @matricarmz/backend-api exec tsx src/scripts/measureAnswer.ts
//   ... --menu=full --repeat=3 --actor=valstan
//   ... --questions="Сколько двигателей на заводе?|Какие марки есть?"
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { and, eq, isNull } from 'drizzle-orm';

import { getEffectivePermissionsForUser } from '../auth/permissions.js';
import { db } from '../database/db.js';
import { users } from '../database/schema.js';
import {
  ANSWER_MAX_STEPS,
  buildIivanychSystemBlocks,
} from '../services/ai/aiChatAnswerService.js';
import { AI_MODEL_ANALYTICS } from '../services/ai/common.js';
import { callLlmWithTools, type LlmToolUse } from '../services/ai/llmProvider.js';
import {
  ANSWER_COMPACT_TOOL_NAMES,
  FULL_TOOL_NAMES,
  executeTool,
  getToolDefinitions,
  type ToolContext,
} from '../services/ai/llmTools.js';
import { IIVANYCH_TOOLS, runIivanychTool, type IivanychAnswerSide } from '../services/ai/iivanychTools.js';

/** Вопросы по умолчанию — обычные вопросы оператора (не аналитика). */
const DEFAULT_QUESTIONS = [
  'Сколько двигателей на заводе?',
  'Сколько болтов на основном складе?',
  'Какие марки двигателей у нас есть?',
  'Найди заказчика ОВК',
];

/**
 * Права для замера: когда актор не задан, даём инструментам полный набор прав.
 * Замер — про поведение модели (шаги, токены, кэш), а не про разграничение доступа;
 * с настоящими правами на стенде цифры зависели бы от того, кто заведён в dev-БД.
 */
const FULL_PERMISSIONS: Record<string, boolean> = {
  'parts.view': true,
  'engines.view': true,
  'masterdata.view': true,
  'reports.view': true,
  'operations.view': true,
  'employees.view': true,
  'erp.cards.view': true,
  'admin.users.manage': true,
};

type Args = {
  menu: 'compact' | 'full';
  repeat: number;
  actor: string | null;
  questions: string[];
};

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const menu = get('menu') === 'full' ? 'full' : 'compact';
  const repeat = Math.max(1, Number(get('repeat') ?? 1) || 1);
  const questions = (get('questions') ?? '')
    .split('|')
    .map((q) => q.trim())
    .filter(Boolean);
  return { menu, repeat, actor: get('actor'), questions: questions.length ? questions : DEFAULT_QUESTIONS };
}

/** Файл из каталога ключей машины владельца (вне репозитория). */
function keyFile(name: string): string | null {
  try {
    const raw = readFileSync(join(homedir(), '.matricarmz-keys', name), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Ключ из комнаты КАРМАНА — на лету, значение наружу не печатается. */
async function readVaultSecret(key: string): Promise<string> {
  const token = process.env.SECRETS_TOKEN?.trim() || keyFile('karman-token');
  const url = (process.env.SECRETS_VAULT_URL?.trim() || keyFile('vault-url'))?.replace(/\/+$/, '');
  if (!token || !url) {
    throw new Error(
      'нет доступа к комнате: задай SECRETS_TOKEN и SECRETS_VAULT_URL или положи их в ~/.matricarmz-keys/',
    );
  }
  const res = await fetch(`${url}/api/secrets?key=${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`комната ответила HTTP ${res.status}`);
  const body = (await res.json()) as { secrets?: Record<string, string> };
  const value = body.secrets?.[key];
  if (!value) throw new Error(`в комнате нет ключа ${key}`);
  return value;
}

async function toolContext(actor: string | null): Promise<ToolContext> {
  if (!actor) return { actorId: 'measure', permissions: FULL_PERMISSIONS };
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.login, actor), isNull(users.deletedAt)))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) throw new Error(`в базе нет живого сотрудника с логином «${actor}»`);
  const permissions = await getEffectivePermissionsForUser(id);
  return { actorId: id, permissions };
}

type Row = {
  question: string;
  steps: number;
  tools: string;
  expanded: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheShare: number;
  ms: number;
  text: string;
};

async function measureOne(
  question: string,
  args: Args,
  ctx: ToolContext,
): Promise<Row> {
  const side: IivanychAnswerSide = { escalationReason: null, tables: [], fullToolsEnabled: false };
  const started = Date.now();
  const result = await callLlmWithTools({
    model: AI_MODEL_ANALYTICS,
    systemBlocks: buildIivanychSystemBlocks(null),
    userMessage: `Вопрос сотрудника оператор:\n${question}`,
    tools: () =>
      side.fullToolsEnabled || args.menu === 'full'
        ? [...getToolDefinitions(FULL_TOOL_NAMES), ...IIVANYCH_TOOLS]
        : [...getToolDefinitions(ANSWER_COMPACT_TOOL_NAMES), ...IIVANYCH_TOOLS],
    scope: 'measure',
    options: { timeoutMs: 5 * 60_000, maxTokens: 4_000, temperature: 0.2 },
    maxSteps: ANSWER_MAX_STEPS,
    executeTool: async (toolUse: LlmToolUse) => {
      const own = await runIivanychTool(toolUse, side);
      if (own) return own;
      return executeTool(toolUse, ctx);
    },
  });
  const input = result.inputTokens ?? 0;
  const cacheRead = result.cacheReadTokens ?? 0;
  const total = input + cacheRead;
  return {
    question,
    steps: result.steps,
    tools: result.toolUses.map((t) => t.name).join(',') || '—',
    expanded: side.fullToolsEnabled,
    inputTokens: input,
    outputTokens: result.outputTokens ?? 0,
    cacheRead,
    cacheShare: total > 0 ? Math.round((cacheRead / total) * 100) : 0,
    ms: Date.now() - started,
    text: (result.text ?? '').replace(/\s+/g, ' ').slice(0, 300),
  };
}

function printRows(rows: Row[]): void {
  const head = ['вопрос', 'шаги', 'инструменты', 'вход', 'выход', 'кэш', '%кэш', 'мс'];
  console.log('\n' + head.join(' | '));
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(
      [
        r.question.slice(0, 32),
        String(r.steps),
        r.tools.slice(0, 40),
        String(r.inputTokens),
        String(r.outputTokens),
        String(r.cacheRead),
        `${r.cacheShare}%`,
        String(r.ms),
      ].join(' | '),
    );
    if (r.expanded) console.log('   ↳ модель запросила расширенный набор инструментов');
    // Текст ответа — чтобы видеть, что кэш не испортил качество: короткий ответ
    // по данным из кэша хуже полного только если модель потеряла сами данные.
    if (r.text) console.log(`   ответ: ${r.text}`);
  }
  const avg = (pick: (r: Row) => number): string =>
    (rows.reduce((sum, r) => sum + pick(r), 0) / Math.max(1, rows.length)).toFixed(1);
  console.log(
    `\nИТОГО: средние — шаги ${avg((r) => r.steps)}, вход ${avg((r) => r.inputTokens)}, ` +
      `выход ${avg((r) => r.outputTokens)}, кэш ${avg((r) => r.cacheShare)}%, время ${avg((r) => r.ms)} мс; ` +
      `расширений ${rows.filter((r) => r.expanded).length} из ${rows.length}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `Стенд: модель ${AI_MODEL_ANALYTICS}, меню ${args.menu}, повторов ${args.repeat}, ` +
      `потолок шагов ${ANSWER_MAX_STEPS}, ` +
      `актор ${args.actor ?? '— (полные права)'}`,
  );

  const key = await readVaultSecret('DEEPSEEK_API_KEY');
  process.env.MATRICA_AI_DEEPSEEK_API_KEY = key;
  const ctx = await toolContext(args.actor);

  const rows: Row[] = [];
  for (const question of args.questions) {
    for (let i = 0; i < args.repeat; i += 1) {
      rows.push(await measureOne(question, args, ctx));
    }
  }
  printRows(rows);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('стенд упал:', String(e));
    process.exit(1);
  },
);
