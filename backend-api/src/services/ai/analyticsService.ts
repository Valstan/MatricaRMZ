import { pool } from '../../database/db.js';
import { getEffectivePermissionsForUser } from '../../auth/permissions.js';
import {
  AI_AGENT_BUSY_MESSAGE,
  OLLAMA_TIMEOUT_ANALYTICS_MS,
  callOllamaJson,
  getModelForMode,
  isTimeoutError,
  nowMs,
  truncate,
} from './common.js';
import { recordAssistMetrics } from './metricsService.js';
import { retrieveRagMemories } from './ragService.js';

const AI_ANALYTICS_ENABLED = String(process.env.AI_ANALYTICS_ENABLED ?? 'true').toLowerCase() === 'true';
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
  if (!/^select\s/i.test(normalized)) return { ok: false as const, error: 'only SELECT is allowed' };
  if (normalized.includes(';')) return { ok: false as const, error: 'multiple statements not allowed' };
  if (FORBIDDEN_SQL.test(normalized)) return { ok: false as const, error: 'forbidden SQL keyword' };
  if (normalized.includes('--') || normalized.includes('/*')) return { ok: false as const, error: 'comments not allowed' };
  const tables = extractTables(normalized);
  for (const t of tables) {
    if (!policy.allowedTables.has(t)) return { ok: false as const, error: `table not allowed: ${t}` };
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
    if (!policy.allowedTables.has('entities') || !policy.allowedTables.has('entity_types')) return { ok: false as const, error: 'no access for engine count' };
    const sql =
      'select count(*)::int as count from entities e join entity_types t on t.id = e.type_id where t.code = \'engine\' and e.deleted_at is null';
    const result = await runSqlQuery(sql, []);
    return { ok: true as const, sql, rows: result.rows, tookMs: result.tookMs, explain: 'Подсчитано количество активных двигателей.' };
  }
  if (text.includes('сколько') && text.includes('сотрудник')) {
    if (!policy.allowedTables.has('entities') || !policy.allowedTables.has('entity_types')) return { ok: false as const, error: 'no access for employee count' };
    const sql =
      'select count(*)::int as count from entities e join entity_types t on t.id = e.type_id where t.code = \'employee\' and e.deleted_at is null';
    const result = await runSqlQuery(sql, []);
    return { ok: true as const, sql, rows: result.rows, tookMs: result.tookMs, explain: 'Подсчитано количество активных сотрудников.' };
  }
  return { ok: false as const, error: 'no heuristic match' };
}

async function detectAnalyticsIntent(model: string, message: string) {
  const system = 'Определи тип аналитического запроса. Верни JSON: {"intent":"count|list|search|aggregate|compare|other","needsSql":true|false}.';
  const user = `Запрос: ${message}`;
  const json = await callOllamaJson(model, system, user, { timeoutMs: Math.min(OLLAMA_TIMEOUT_ANALYTICS_MS, 20_000), temperature: 0 });
  const intent = String(json?.intent ?? 'other');
  return { intent, needsSql: json?.needsSql !== false };
}

async function proposeSql(model: string, message: string, policy: AccessPolicy, memories: string[]) {
  const allowed = Array.from(policy.allowedTables.values()).sort().join(', ');
  const systemPrompt =
    'Ты помощник аналитик. Верни строго JSON: {"sql":"SELECT ...","params":[...],"note":"коротко"}.\n' +
    'Правила: только SELECT, без комментариев, только таблицы из списка.';
  const userPrompt =
    `Доступные таблицы: ${allowed}\n` +
    `Контекст памяти:\n${memories.length ? memories.map((x, i) => `${i + 1}) ${x}`).join('\n') : 'n/a'}\n` +
    `Запрос пользователя: ${message}\n` +
    `Сформируй SQL с LIMIT не более ${MAX_ROWS}.`;
  const json = await callOllamaJson(model, systemPrompt, userPrompt, {
    timeoutMs: OLLAMA_TIMEOUT_ANALYTICS_MS,
    temperature: 0,
    numPredict: 260,
  });
  if (!json || typeof json.sql !== 'string') return { ok: false as const, error: 'LLM did not return SQL' };
  return { ok: true as const, sql: String(json.sql), params: Array.isArray(json.params) ? json.params : [], note: String(json.note ?? '') };
}

export async function runAnalyticsAssist(args: { actorId: string; context: any; message: string }) {
  const startedAt = nowMs();
  const model = getModelForMode('analytics');
  if (!AI_ANALYTICS_ENABLED) {
    return { ok: true as const, replyText: 'Аналитические возможности ИИ временно отключены. Доступен только чат.', model, timeout: false };
  }
  const policy = buildAccessPolicy(await getEffectivePermissionsForUser(args.actorId));
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
  const intentStart = nowMs();
  try {
    await detectAnalyticsIntent(model, args.message);
  } catch {
    // non-blocking hint step
  }
  const intentMs = nowMs() - intentStart;

  let plan: SqlPlan | null = getCachedPlan(args.actorId, args.message);
  let sqlPlanMs = 0;
  if (!plan) {
    const planStart = nowMs();
    let proposed: Awaited<ReturnType<typeof proposeSql>>;
    try {
      proposed = await proposeSql(model, args.message, policy, memories);
    } catch (e) {
      const timeout = isTimeoutError(e);
      await recordAssistMetrics({
        actorId: args.actorId,
        mode: 'analytics',
        model,
        ok: false,
        timeout,
        context: args.context,
        timings: { totalMs: nowMs() - startedAt, ragMs, sqlPlanMs: nowMs() - planStart },
      });
      if (timeout) return { ok: true as const, replyText: AI_AGENT_BUSY_MESSAGE, model, timeout: true };
      return { ok: false as const, error: String(e ?? 'ollama error'), model, timeout: false };
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
      routeMs: intentMs,
      sqlPlanMs,
      sqlExecMs: exec.tookMs,
    },
  });
  return { ok: true as const, replyText, model, timeout: false };
}
