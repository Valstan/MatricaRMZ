import { pool } from '../../database/db.js';
import { getEffectivePermissionsForUser } from '../../auth/permissions.js';
import {
  AI_AGENT_BUSY_MESSAGE,
  AI_AGENT_MISCONFIGURED_MESSAGE,
  AI_ANALYTICS_MAX_TOKENS_DEFAULT,
  CLAUDE_TIMEOUT_ANALYTICS_MS,
  getModelForMode,
  isTimeoutError,
  nowMs,
  truncate,
} from './common.js';
import {
  callClaudeJson,
  callClaudeWithTools,
  isClaudeMisconfigured,
  type ClaudeToolUse,
  type SystemBlock,
} from './claudeProvider.js';
import {
  FULL_TOOL_NAMES,
  executeTool,
  getToolDefinitions,
  type ToolContext,
} from './claudeTools.js';
import { recordAssistMetrics } from './metricsService.js';
import { retrieveRagMemories } from './ragService.js';

const AI_ANALYTICS_MAX_TOKENS = Number(process.env.AI_ANALYTICS_MAX_TOKENS ?? AI_ANALYTICS_MAX_TOKENS_DEFAULT);

const AI_ANALYTICS_ENABLED = String(process.env.AI_ANALYTICS_ENABLED ?? 'true').toLowerCase() === 'true';
const AI_ANALYTICS_TOOLS_ENABLED = String(process.env.AI_ANALYTICS_TOOLS_ENABLED ?? 'true').toLowerCase() === 'true';
const MAX_ROWS = 200;
const PREVIEW_ROWS = 20;
const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|merge)\b/i;

type AccessPolicy = { allowedTables: Set<string> };
type SqlPlan = { sql: string; params: unknown[]; note?: string };

const planCache = new Map<string, { expiresAt: number; plan: SqlPlan }>();

function cacheKey(actorId: string, message: string) {
  return `${actorId}::${String(message ?? '').trim().toLowerCase()}`;
}

function getCachedPlan(actorId: string, message: string) {
  const item = planCache.get(cacheKey(actorId, message));
  if (!item) return null;
  if (item.expiresAt < nowMs()) {
    planCache.delete(cacheKey(actorId, message));
    return null;
  }
  return item.plan;
}

function setCachedPlan(actorId: string, message: string, plan: SqlPlan) {
  planCache.set(cacheKey(actorId, message), { plan, expiresAt: nowMs() + 5 * 60_000 });
}

function buildAccessPolicy(perms: Record<string, boolean>): AccessPolicy {
  const allowedTables = new Set<string>();
  const allow = (table: string) => allowedTables.add(table);
  const can = (code: string) => perms?.[code] === true;
  if (can('masterdata.view')) {
    allow('entity_types');
    allow('attribute_defs');
  }
  if (can('engines.view') || can('parts.view') || can('employees.view')) {
    allow('entities');
    allow('attribute_values');
    allow('entity_types');
    allow('attribute_defs');
  }
  if (can('operations.view') || can('supply_requests.view')) allow('operations');
  if (can('files.view')) allow('file_assets');
  if (can('clients.manage')) {
    allow('sync_state');
    allow('ledger_tx_index');
    allow('client_settings');
  }
  return { allowedTables };
}

export function isAnalyticsQuery(message: string) {
  const text = String(message ?? '').toLowerCase();
  if (text.startsWith('/db') || text.startsWith('/sql')) return true;
  if (text.startsWith('/compare') || text.includes('сравни')) return true;
  return (
    text.includes('свод') ||
    text.includes('отчет') ||
    text.includes('отчёт') ||
    text.includes('сколько') ||
    text.includes('сумм') ||
    text.includes('список') ||
    text.includes('найди') ||
    text.includes('поиск') ||
    text.includes('фильтр')
  );
}

function extractTables(sql: string): string[] {
  const tables: string[] = [];
  const re = /\bfrom\s+([a-z_][a-z0-9_]*)|\bjoin\s+([a-z_][a-z0-9_]*)/gi;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(sql))) {
    const name = (m[1] || m[2] || '').toLowerCase();
    if (name) tables.push(name);
  }
  return Array.from(new Set(tables));
}

function normalizeSql(sql: string) {
  return String(sql ?? '').trim().replace(/\s+/g, ' ');
}

function validateSql(sql: string, policy: AccessPolicy) {
  const normalized = normalizeSql(sql);
  if (!/^select\s/i.test(normalized)) return { ok: false as const, error: 'Разрешены только SELECT-запросы.' };
  if (normalized.includes(';')) return { ok: false as const, error: 'Нельзя выполнять несколько SQL-операторов за один раз.' };
  if (FORBIDDEN_SQL.test(normalized)) return { ok: false as const, error: 'Обнаружено запрещённое ключевое слово SQL.' };
  if (normalized.includes('--') || normalized.includes('/*')) return { ok: false as const, error: 'Комментирование SQL-запроса недоступно.' };
  const tables = extractTables(normalized);
  for (const t of tables) {
    if (!policy.allowedTables.has(t)) return { ok: false as const, error: `Таблица недоступна: ${t}` };
  }
  let finalSql = normalized;
  if (!/\blimit\b/i.test(finalSql)) finalSql = `${finalSql} LIMIT ${MAX_ROWS}`;
  return { ok: true as const, sql: finalSql };
}

async function runSqlQuery(sql: string, params: unknown[]) {
  const start = nowMs();
  const res = await pool.query(sql, params as any[]);
  return { rows: res.rows ?? [], tookMs: nowMs() - start };
}

function formatRowsForUser(rows: any[]) {
  if (!rows || rows.length === 0) return 'Нет данных.';
  const first = rows[0] as Record<string, unknown> | undefined;
  if (!first) return 'Нет данных.';
  const keys = Object.keys(first);
  if (keys.length === 1 && keys[0] && keys[0].toLowerCase() === 'count') return `Найдено: ${String(first[keys[0]] ?? 0)}`;
  const preview = rows.slice(0, PREVIEW_ROWS);
  const lines = preview.map((r, idx) => `${idx + 1}. ` + keys.map((k) => `${k}: ${String((r as Record<string, unknown>)[k])}`).join(', '));
  const more = rows.length > PREVIEW_ROWS ? `\n… и ещё ${rows.length - PREVIEW_ROWS} строк.` : '';
  return `Строк: ${rows.length}\n` + lines.join('\n') + more;
}

async function runHeuristicQuery(message: string, policy: AccessPolicy) {
  const text = String(message ?? '').toLowerCase();
  if (text.includes('сколько') && text.includes('двигател')) {
    if (!policy.allowedTables.has('entities') || !policy.allowedTables.has('entity_types'))
      return { ok: false as const, error: 'Нет доступа к данным по двигателям.' };
    const sql =
      'select count(*)::int as count from entities e join entity_types t on t.id = e.type_id where t.code = \'engine\' and e.deleted_at is null';
    const result = await runSqlQuery(sql, []);
    return { ok: true as const, sql, rows: result.rows, tookMs: result.tookMs, explain: 'Подсчитано количество активных двигателей.' };
  }
  if (text.includes('сколько') && text.includes('сотрудник')) {
    if (!policy.allowedTables.has('entities') || !policy.allowedTables.has('entity_types'))
      return { ok: false as const, error: 'Нет доступа к данным по сотрудникам.' };
    const sql =
      'select count(*)::int as count from entities e join entity_types t on t.id = e.type_id where t.code = \'employee\' and e.deleted_at is null';
    const result = await runSqlQuery(sql, []);
    return { ok: true as const, sql, rows: result.rows, tookMs: result.tookMs, explain: 'Подсчитано количество активных сотрудников.' };
  }
  return { ok: false as const, error: 'Точная эвристика не нашлась, попробуйте сформулировать запрос точнее.' };
}

type SqlProposalJson = { sql?: string; params?: unknown[]; note?: string };

async function proposeSql(model: string, message: string, policy: AccessPolicy, memories: string[]) {
  const allowed = Array.from(policy.allowedTables.values()).sort().join(', ');
  const systemPrompt =
    'Ты SQL-помощник в системе Матрица РМЗ (PostgreSQL).\n' +
    'Правила: только SELECT-запросы, без комментариев, без точек с запятой внутри, ' +
    'используй только перечисленные таблицы. Для подсчётов используй count(*)::int. ' +
    'Параметризованные значения передавай через $1, $2 и т.д. с соответствующим массивом params.';
  const userPrompt =
    `Доступные таблицы: ${allowed}\n` +
    `Контекст памяти (релевантные факты пользователя):\n${memories.length ? memories.map((x, i) => `${i + 1}) ${x}`).join('\n') : 'н/д'}\n\n` +
    `Запрос пользователя: ${message}\n\n` +
    `Сформируй один SELECT-запрос с LIMIT не более ${MAX_ROWS}.`;
  const json = await callClaudeJson<SqlProposalJson>({
    model,
    system: systemPrompt,
    user: userPrompt,
    toolName: 'propose_sql',
    toolDescription: 'Сформируй SQL-запрос для ответа на вопрос пользователя.',
    schema: {
      properties: {
        sql: {
          type: 'string',
          description: 'SQL SELECT-запрос (PostgreSQL), один statement, с LIMIT',
        },
        params: {
          type: 'array',
          description: 'Массив параметров для $1, $2, ... в SQL (пустой если параметров нет)',
          items: { type: 'string', description: 'Значение параметра' },
        },
        note: {
          type: 'string',
          description: 'Краткое описание что делает запрос на русском (для пользователя)',
        },
      },
      required: ['sql', 'note'],
    },
    options: { timeoutMs: CLAUDE_TIMEOUT_ANALYTICS_MS, temperature: 0, maxTokens: AI_ANALYTICS_MAX_TOKENS },
  });
  if (!json || typeof json.sql !== 'string') return { ok: false as const, error: 'Claude не вернул SQL-запрос.' };
  return {
    ok: true as const,
    sql: String(json.sql),
    params: Array.isArray(json.params) ? json.params : [],
    note: String(json.note ?? ''),
  };
}

async function runAnalyticsViaTools(args: {
  actorId: string;
  context: any;
  message: string;
  memories: string[];
  model: string;
  perms: Record<string, boolean>;
}) {
  const toolDefs = getToolDefinitions(FULL_TOOL_NAMES);
  const replyToolDef = {
    name: 'present_answer',
    description: 'Финальный ответ пользователю на русском. text — готовый человекочитаемый ответ.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string' },
        sqlUsed: { type: 'string', description: 'Опционально: какой SQL/tool был выполнен.' },
      },
      required: ['text'],
    },
  };
  const systemBlocks: SystemBlock[] = [
    {
      type: 'text',
      text:
        'Ты аналитик базы данных Матрица РМЗ. Используй tools (query_nomenclature, get_stock_balances, ' +
        'get_inventory_forecast, get_operations, get_engine_details, get_employees_list, get_contracts, ' +
        'query_diagnostics_snapshots, execute_safe_sql и др.) чтобы найти данные. ' +
        'Чувствительные поля (зарплаты, паспорта, токены) недоступны — если пользователь о них спрашивает, ' +
        'честно ответь что эти данные защищены. ' +
        'После получения данных вызови present_answer с готовым ответом на русском.',
    },
    {
      type: 'text',
      text:
        args.memories.length > 0
          ? `Память (релевантные факты):\n${args.memories.map((m, i) => `${i + 1}) ${m}`).join('\n')}`
          : 'Память: пусто.',
      cacheable: true,
    },
  ];
  const ctx: ToolContext = { actorId: args.actorId, permissions: args.perms };
  const toolCallNames: string[] = [];
  const result = await callClaudeWithTools({
    model: args.model,
    systemBlocks,
    userMessage: `Запрос: ${args.message}`,
    tools: [...toolDefs, replyToolDef],
    options: {
      timeoutMs: CLAUDE_TIMEOUT_ANALYTICS_MS,
      maxTokens: AI_ANALYTICS_MAX_TOKENS,
      temperature: 0,
    },
    maxSteps: 6,
    executeTool: async (toolUse: ClaudeToolUse) => {
      toolCallNames.push(toolUse.name);
      if (toolUse.name === 'present_answer') {
        return { content: JSON.stringify(toolUse.input) };
      }
      return executeTool(toolUse, ctx);
    },
  });
  const lastReply = [...result.toolUses].reverse().find((t) => t.name === 'present_answer');
  const text =
    (lastReply?.input as { text?: string } | undefined)?.text ??
    result.text ??
    'Не удалось сформировать ответ.';
  return {
    replyText: truncate(text, 4000),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    toolCalls: toolCallNames,
  };
}

export async function runAnalyticsAssist(args: { actorId: string; context: any; message: string }) {
  const startedAt = nowMs();
  const model = getModelForMode('analytics');
  if (!AI_ANALYTICS_ENABLED) {
    return { ok: true as const, replyText: 'Аналитические возможности ИИ временно отключены. Доступен только чат.', model, timeout: false };
  }
  const perms = await getEffectivePermissionsForUser(args.actorId);
  const policy = buildAccessPolicy(perms);
  if (!policy.allowedTables.size) {
    return { ok: true as const, replyText: 'Недостаточно прав для аналитики.', model, timeout: false };
  }
  const heuristic = await runHeuristicQuery(args.message, policy);
  if (heuristic.ok) {
    await recordAssistMetrics({
      actorId: args.actorId,
      mode: 'analytics',
      model,
      ok: true,
      timeout: false,
      context: args.context,
      timings: { totalMs: nowMs() - startedAt, sqlExecMs: heuristic.tookMs },
    });
    return {
      ok: true as const,
      replyText: `${formatRowsForUser(heuristic.rows ?? [])}\n\nЧто сделано: ${heuristic.explain}`,
      model,
      timeout: false,
    };
  }

  const ragStart = nowMs();
  const memories = await retrieveRagMemories({
    actorId: args.actorId,
    message: args.message,
    context: { tab: args.context?.tab, entityType: args.context?.entityType },
    topK: 3,
  }).catch(() => []);
  const ragMs = nowMs() - ragStart;

  if (AI_ANALYTICS_TOOLS_ENABLED) {
    try {
      const result = await runAnalyticsViaTools({
        actorId: args.actorId,
        context: args.context,
        message: args.message,
        memories,
        model,
        perms,
      });
      await recordAssistMetrics({
        actorId: args.actorId,
        mode: 'analytics',
        model,
        ok: true,
        timeout: false,
        context: args.context,
        timings: { totalMs: nowMs() - startedAt, ragMs },
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        toolCalls: result.toolCalls,
      });
      return { ok: true as const, replyText: result.replyText, model, timeout: false };
    } catch (e) {
      const timeout = isTimeoutError(e);
      const misconfigured = isClaudeMisconfigured(e);
      await recordAssistMetrics({
        actorId: args.actorId,
        mode: 'analytics',
        model,
        ok: false,
        timeout,
        context: args.context,
        timings: { totalMs: nowMs() - startedAt, ragMs },
      });
      if (misconfigured) return { ok: true as const, replyText: AI_AGENT_MISCONFIGURED_MESSAGE, model, timeout: false };
      if (timeout) return { ok: true as const, replyText: AI_AGENT_BUSY_MESSAGE, model, timeout: true };
      // не возвращаем error — мягко падаем в legacy SQL-pipeline ниже
    }
  }

  let plan: SqlPlan | null = getCachedPlan(args.actorId, args.message);
  let sqlPlanMs = 0;
  if (!plan) {
    const planStart = nowMs();
    let proposed: Awaited<ReturnType<typeof proposeSql>>;
    try {
      proposed = await proposeSql(model, args.message, policy, memories);
    } catch (e) {
      const timeout = isTimeoutError(e);
      const misconfigured = isClaudeMisconfigured(e);
      await recordAssistMetrics({
        actorId: args.actorId,
        mode: 'analytics',
        model,
        ok: false,
        timeout,
        context: args.context,
        timings: { totalMs: nowMs() - startedAt, ragMs, sqlPlanMs: nowMs() - planStart },
      });
      if (misconfigured) return { ok: true as const, replyText: AI_AGENT_MISCONFIGURED_MESSAGE, model, timeout: false };
      if (timeout) return { ok: true as const, replyText: AI_AGENT_BUSY_MESSAGE, model, timeout: true };
      return { ok: false as const, error: String(e ?? 'ошибка обращения к Claude'), model, timeout: false };
    }
    sqlPlanMs = nowMs() - planStart;
    if (!proposed.ok) {
      await recordAssistMetrics({
        actorId: args.actorId,
        mode: 'analytics',
        model,
        ok: true,
        timeout: false,
        context: args.context,
        timings: { totalMs: nowMs() - startedAt, ragMs, sqlPlanMs },
      });
      return { ok: true as const, replyText: proposed.error, model, timeout: false };
    }
    const validated = validateSql(proposed.sql, policy);
    if (!validated.ok) {
      await recordAssistMetrics({
        actorId: args.actorId,
        mode: 'analytics',
        model,
        ok: true,
        timeout: false,
        context: args.context,
        timings: { totalMs: nowMs() - startedAt, ragMs, sqlPlanMs },
      });
      return { ok: true as const, replyText: validated.error, model, timeout: false };
    }
    plan = { sql: validated.sql, params: proposed.params, note: proposed.note };
    setCachedPlan(args.actorId, args.message, plan);
  }

  const exec = await runSqlQuery(plan.sql, plan.params);
  const explain = `SQL выполнен за ${exec.tookMs}мс${plan.note ? `. Комментарий: ${truncate(plan.note, 200)}` : ''}.`;
  const replyText = `${formatRowsForUser(exec.rows ?? [])}\n\nЧто сделано: ${explain}`;
  await recordAssistMetrics({
    actorId: args.actorId,
    mode: 'analytics',
    model,
    ok: true,
    timeout: false,
    context: args.context,
    timings: {
      totalMs: nowMs() - startedAt,
      ragMs,
      sqlPlanMs,
      sqlExecMs: exec.tookMs,
    },
  });
  return { ok: true as const, replyText, model, timeout: false };
}
