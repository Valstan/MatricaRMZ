import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { db, pool } from '../database/db.js';
import { changeLog, chatMessages, diagnosticsSnapshots } from '../database/schema.js';
import { SyncTableName } from '@matricarmz/shared';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import { getEffectivePermissionsForUser } from '../auth/permissions.js';
import { getConsistencyReport } from '../services/diagnosticsConsistencyService.js';

export const aiAgentRouter = Router();
aiAgentRouter.use(requireAuth);
aiAgentRouter.use(requirePermission(PermissionCode.ChatUse));

const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 100_000);

const MAX_ROWS = 200;
const PREVIEW_ROWS = 20;
const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|merge)\b/i;

function nowMs() {
  return Date.now();
}

function truncate(text: string, max = 1000) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function buildContextSummary(ctx: any, ev?: any | null) {
  const parts: string[] = [];
  if (ctx?.tab) parts.push(`tab=${ctx.tab}`);
  if (ctx?.entityType) parts.push(`entityType=${ctx.entityType}`);
  if (ctx?.entityId) parts.push(`entityId=${ctx.entityId}`);
  if (ev?.field?.label || ev?.field?.name) parts.push(`field=${ev.field.label || ev.field.name}`);
  if (ev?.valuePreview) parts.push(`value="${truncate(ev.valuePreview, 120)}"`);
  if (ev?.durationMs != null) parts.push(`durationMs=${ev.durationMs}`);
  if (ev?.idleMs != null) parts.push(`idleMs=${ev.idleMs}`);
  return parts.join(' | ');
}

function isAnalyticsQuery(message: string) {
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

type AccessPolicy = {
  allowedTables: Set<string>;
};

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
  if (can('operations.view') || can('supply_requests.view')) {
    allow('operations');
  }
  if (can('files.view')) {
    allow('file_assets');
  }
  if (can('clients.manage')) {
    allow('sync_state');
    allow('change_log');
    allow('client_settings');
  }
  return { allowedTables };
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
  if (!/\blimit\b/i.test(finalSql)) {
    finalSql = `${finalSql} LIMIT ${MAX_ROWS}`;
  }
  return { ok: true as const, sql: finalSql };
}

function extractSearchTerm(message: string) {
  const text = String(message ?? '').trim();
  const match = text.match(/(\d{3,})/);
  if (match) return match[1];
  const words = text.split(/\s+/).filter((w) => w.length > 2);
  return words.slice(-1)[0] ?? '';
}

async function runHeuristicQuery(message: string, policy: AccessPolicy) {
  const text = String(message ?? '').toLowerCase();
  if (text.includes('сколько') && text.includes('двигател')) {
    if (!policy.allowedTables.has('entities') || !policy.allowedTables.has('entity_types')) {
      return { ok: false as const, error: 'no access for engine count' };
    }
    const sql =
      'select count(*)::int as count from entities e ' +
      'join entity_types t on t.id = e.type_id ' +
      "where t.code = 'engine' and e.deleted_at is null";
    const result = await runSqlQuery(sql, []);
    return { ok: true as const, sql, rows: result.rows, tookMs: result.tookMs };
  }
  if (text.includes('список') && text.includes('двигател')) {
    if (
      !policy.allowedTables.has('entities') ||
      !policy.allowedTables.has('entity_types') ||
      !policy.allowedTables.has('attribute_defs') ||
      !policy.allowedTables.has('attribute_values')
    ) {
      return { ok: false as const, error: 'no access for engine list' };
    }
    const sql = `
      select
        e.id,
        (num.value_json::jsonb #>> '{}') as engine_number,
        coalesce(
          (brand_txt.value_json::jsonb #>> '{}'),
          (brand_name.value_json::jsonb #>> '{}')
        ) as engine_brand
      from entities e
      join entity_types t on t.id = e.type_id
      left join attribute_defs d_num on d_num.entity_type_id = e.type_id and d_num.code = 'engine_number' and d_num.deleted_at is null
      left join attribute_values num on num.entity_id = e.id and num.attribute_def_id = d_num.id and num.deleted_at is null
      left join attribute_defs d_brand_txt on d_brand_txt.entity_type_id = e.type_id and d_brand_txt.code = 'engine_brand' and d_brand_txt.deleted_at is null
      left join attribute_values brand_txt on brand_txt.entity_id = e.id and brand_txt.attribute_def_id = d_brand_txt.id and brand_txt.deleted_at is null
      left join attribute_defs d_brand_id on d_brand_id.entity_type_id = e.type_id and d_brand_id.code = 'engine_brand_id' and d_brand_id.deleted_at is null
      left join attribute_values brand_id on brand_id.entity_id = e.id and brand_id.attribute_def_id = d_brand_id.id and brand_id.deleted_at is null
      left join entities eb on eb.id = (brand_id.value_json::jsonb #>> '{}')::uuid
      left join attribute_defs d_brand_name on d_brand_name.entity_type_id = eb.type_id and d_brand_name.code = 'name' and d_brand_name.deleted_at is null
      left join attribute_values brand_name on brand_name.entity_id = eb.id and brand_name.attribute_def_id = d_brand_name.id and brand_name.deleted_at is null
      where t.code = 'engine' and e.deleted_at is null
      order by e.updated_at desc
      limit ${MAX_ROWS}
    `;
    const result = await runSqlQuery(sql, []);
    return { ok: true as const, sql, rows: result.rows, tookMs: result.tookMs };
  }
  if (text.includes('файл') || text.includes('файлы')) {
    if (!policy.allowedTables.has('file_assets')) {
      return { ok: false as const, error: 'no access for file search' };
    }
    const term = extractSearchTerm(message);
    if (!term) return { ok: false as const, error: 'missing search term' };
    const sql =
      'select id, name, size, mime, created_at from file_assets ' +
      'where deleted_at is null and name ilike $1 ' +
      `order by created_at desc limit ${MAX_ROWS}`;
    const result = await runSqlQuery(sql, [`%${term}%`]);
    return { ok: true as const, sql, rows: result.rows, tookMs: result.tookMs };
  }
  return { ok: false as const, error: 'no heuristic match' };
}

function formatRows(rows: any[]) {
  if (!rows || rows.length === 0) return 'Нет данных.';
  const keys = Object.keys(rows[0] ?? {});
  const preview = rows.slice(0, PREVIEW_ROWS);
  const lines = preview.map((r) => keys.map((k) => `${k}=${String(r[k])}`).join(' | '));
  const more = rows.length > PREVIEW_ROWS ? `\n… и ещё ${rows.length - PREVIEW_ROWS} строк.` : '';
  return `Строк: ${rows.length}\n` + lines.join('\n') + more;
}

function formatRowsForUser(rows: any[]) {
  if (!rows || rows.length === 0) return 'Нет данных.';
  const first = rows[0] as Record<string, unknown> | undefined;
  if (!first) return 'Нет данных.';
  const keys = Object.keys(first);
  if (keys.length === 1 && keys[0] && keys[0].toLowerCase() === 'count') {
    const v = first[keys[0]] as unknown;
    return `Найдено: ${String(v ?? 0)}`;
  }
  if (keys.includes('engine_number') || keys.includes('engine_brand')) {
    const preview = rows.slice(0, PREVIEW_ROWS);
    const lines = preview.map((r, idx) => {
      const row = r as Record<string, unknown>;
      const num = row.engine_number ? String(row.engine_number) : '—';
      const brand = row.engine_brand ? String(row.engine_brand) : '—';
      return `${idx + 1}. № ${num} — ${brand}`;
    });
    const more = rows.length > PREVIEW_ROWS ? `\n… и ещё ${rows.length - PREVIEW_ROWS} строк.` : '';
    return `Строк: ${rows.length}\n` + lines.join('\n') + more;
  }
  const preview = rows.slice(0, PREVIEW_ROWS);
  const lines = preview.map(
    (r, idx) => `${idx + 1}. ` + keys.map((k) => `${k}: ${String((r as Record<string, unknown>)[k])}`).join(', '),
  );
  const more = rows.length > PREVIEW_ROWS ? `\n… и ещё ${rows.length - PREVIEW_ROWS} строк.` : '';
  return `Строк: ${rows.length}\n` + lines.join('\n') + more;
}

async function callOllamaJson(systemPrompt: string, userPrompt: string) {
  const raw = await callOllama(systemPrompt, userPrompt);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function proposeSql(message: string, policy: AccessPolicy) {
  const allowed = Array.from(policy.allowedTables.values()).sort().join(', ');
  const systemPrompt =
    'Ты помощник аналитик. Верни строго JSON с полями: ' +
    '{"sql":"SELECT ...","params":[...],"note":"коротко"}.\n' +
    'Правила: только SELECT, только таблицы из списка, без комментариев.';
  const userPrompt =
    `Доступные таблицы: ${allowed}\n` +
    `Запрос: ${message}\n` +
    `Если нужен список/сумма/группировка, сформируй SQL. LIMIT обязателен не более ${MAX_ROWS}.`;
  const json = await callOllamaJson(systemPrompt, userPrompt);
  if (!json || typeof json.sql !== 'string') {
    return { ok: false as const, error: 'LLM did not return SQL' };
  }
  const params = Array.isArray(json.params) ? json.params : [];
  return { ok: true as const, sql: String(json.sql), params, note: String(json.note ?? '') };
}

async function runSqlQuery(sql: string, params: any[]) {
  const start = nowMs();
  const res = await pool.query(sql, params);
  const tookMs = nowMs() - start;
  return { rows: res.rows ?? [], tookMs };
}

async function summarizeConsistencyReport() {
  const report = await getConsistencyReport();
  const clients = report.clients ?? [];
  const drift = clients.filter((c) => c.status === 'drift');
  const warning = clients.filter((c) => c.status === 'warning');
  const unknown = clients.filter((c) => c.status === 'unknown');
  const lines: string[] = [];
  lines.push(`Серверный снимок: ${new Date(report.server.generatedAt).toLocaleString('ru-RU')}`);
  lines.push(`Клиенты: drift=${drift.length}, warning=${warning.length}, unknown=${unknown.length}`);
  const list = drift.slice(0, 5).map((c) => `${c.clientId} (lastSeen=${c.lastSeenAt ?? 'n/a'})`);
  if (list.length > 0) lines.push(`Drift: ${list.join(', ')}`);
  return lines.join('\n');
}

async function logSnapshot(scope: string, payload: unknown, actorId?: string | null) {
  const ts = nowMs();
  await db.insert(diagnosticsSnapshots).values({
    id: randomUUID(),
    scope,
    clientId: actorId ? String(actorId) : null,
    payloadJson: JSON.stringify(payload ?? {}),
    createdAt: ts,
  });
}

async function forwardToSuperadminFromUser(actor: { id: string; username: string }, text: string) {
  const superadminId = await getSuperadminUserId();
  if (!superadminId) return;
  const ts = nowMs();
  const id = randomUUID();
  await db.insert(chatMessages).values({
    id,
    senderUserId: actor.id as any,
    senderUsername: actor.username,
    recipientUserId: superadminId as any,
    messageType: 'text',
    bodyText: truncate(text, 5000),
    payloadJson: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  const payload = {
    id,
    sender_user_id: actor.id,
    sender_username: actor.username,
    recipient_user_id: String(superadminId),
    message_type: 'text',
    body_text: truncate(text, 5000),
    payload_json: null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_status: 'synced',
  };
  await db.insert(changeLog).values({
    tableName: SyncTableName.ChatMessages,
    rowId: id as any,
    op: 'upsert',
    payloadJson: JSON.stringify(payload),
    createdAt: ts,
  });
}

async function callOllama(systemPrompt: string, userPrompt: string) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('ollama timeout')), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { temperature: 0.2 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`ollama HTTP ${res.status}: ${t}`.trim());
    }
    const json = await res.json();
    const content = String(json?.message?.content ?? '').trim();
    return content;
  } finally {
    clearTimeout(timer);
  }
}

const assistSchema = z.object({
  message: z.string().min(1).max(5000),
  context: z.object({
    tab: z.string().min(1),
    entityId: z.string().uuid().nullable().optional(),
    entityType: z.string().nullable().optional(),
    breadcrumbs: z.array(z.string()).optional(),
  }),
  lastEvent: z
    .object({
      type: z.string(),
      ts: z.coerce.number(),
      tab: z.string(),
      entityId: z.string().uuid().nullable().optional(),
      entityType: z.string().nullable().optional(),
      field: z
        .object({
          name: z.string().nullable().optional(),
          label: z.string().nullable().optional(),
          placeholder: z.string().nullable().optional(),
          inputType: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
      valuePreview: z.string().nullable().optional(),
      durationMs: z.number().nullable().optional(),
      idleMs: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  recentEvents: z.array(z.any()).optional(),
});

aiAgentRouter.post('/assist', async (req, res) => {
  try {
    const parsed = assistSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });

    const ctx = parsed.data.context;
    const lastEvent = parsed.data.lastEvent ?? null;
    const summary = buildContextSummary(ctx, lastEvent);
    const message = parsed.data.message;
    const messageLower = message.toLowerCase();

    if (
      messageLower.startsWith('/db') ||
      messageLower.startsWith('/sql') ||
      messageLower.startsWith('/compare') ||
      messageLower.includes('сравни') ||
      isAnalyticsQuery(message)
    ) {
      return res.json({
        ok: true,
        reply: { kind: 'info', text: 'Аналитические возможности ИИ временно отключены. Доступен только чат.' },
      });
    }

    const systemPrompt =
      'Ты помощник в программе Матрица РМЗ. Отвечай кратко по делу. ' +
      'Верни ответ строго в JSON: {"kind":"suggestion|question|info","text":"...","actions":["..."]}.';
    const userPrompt =
      `Контекст: ${summary || 'n/a'}\n` +
      `Сообщение пользователя: ${parsed.data.message}\n` +
      'Если нужно задать уточняющий вопрос, используй kind=question.';

    let raw = '';
    try {
      raw = await callOllama(systemPrompt, userPrompt);
    } catch (e) {
      const err = String(e ?? 'ollama error');
      await logSnapshot('ai_agent_assist_error', { actorId: actor.id, context: ctx, lastEvent, message, error: err }, actor.id);
      return res.json({ ok: true, reply: { kind: 'info', text: 'ИИ временно недоступен. Попробуйте позже.' } });
    }
    let reply = { kind: 'info' as const, text: raw, actions: undefined as string[] | undefined };
    try {
      const j = JSON.parse(raw);
      if (j && typeof j.text === 'string') {
        reply = {
          kind: j.kind === 'question' || j.kind === 'suggestion' ? j.kind : 'info',
          text: String(j.text),
          actions: Array.isArray(j.actions) ? j.actions.map((x: any) => String(x)) : undefined,
        };
      }
    } catch {
      // keep raw text
    }

    await logSnapshot('ai_agent_assist', { actorId: actor.id, context: ctx, lastEvent, message: parsed.data.message, reply }, actor.id);
    await forwardToSuperadminFromUser(
      { id: String(actor.id), username: String(actor.username ?? 'user') },
      `[AI Agent] assist\nuser="${actor.username}"\n${summary || ''}\nQ: ${truncate(parsed.data.message, 800)}\nA: ${truncate(reply.text, 1200)}`,
    );

    return res.json({ ok: true, reply });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const logSchema = z.object({
  context: z.object({
    tab: z.string().min(1),
    entityId: z.string().uuid().nullable().optional(),
    entityType: z.string().nullable().optional(),
    breadcrumbs: z.array(z.string()).optional(),
  }),
  event: z.object({
    type: z.string(),
    ts: z.coerce.number(),
    tab: z.string(),
    entityId: z.string().uuid().nullable().optional(),
    entityType: z.string().nullable().optional(),
    field: z
      .object({
        name: z.string().nullable().optional(),
        label: z.string().nullable().optional(),
        placeholder: z.string().nullable().optional(),
        inputType: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    valuePreview: z.string().nullable().optional(),
    durationMs: z.number().nullable().optional(),
    idleMs: z.number().nullable().optional(),
  }),
});

aiAgentRouter.post('/log', async (req, res) => {
  try {
    const parsed = logSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });

    await logSnapshot('ai_agent_event', { actorId: actor.id, context: parsed.data.context, event: parsed.data.event }, actor.id);
    const summary = buildContextSummary(parsed.data.context, parsed.data.event);
    await forwardToSuperadminFromUser(
      { id: String(actor.id), username: String(actor.username ?? 'user') },
      `[AI Agent] event\nuser="${actor.username}"\n${summary || ''}`,
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
