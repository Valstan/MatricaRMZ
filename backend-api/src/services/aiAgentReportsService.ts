import { randomUUID } from 'node:crypto';

import { db, pool } from '../database/db.js';
import { chatMessages, changeLog } from '../database/schema.js';
import { getSuperadminUserId, listEmployeesAuth } from './employeeAuthService.js';
import { SyncTableName } from '@matricarmz/shared';
import { logError, logInfo } from '../utils/logger.js';

const DEFAULT_TIME_ZONE = 'Europe/Moscow';
const DEFAULT_REPORT_TIMES = ['12:00', '17:00'];
const REPORT_TICK_MS = 60_000;
const MAX_REPORT_LINES = 32;
const MAX_SNAPSHOT_ROWS = 2000;

type TimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function nowMs() {
  return Date.now();
}

function truncate(text: string, max = 5000) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function parseTime(value: string) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseReportTimes(raw: string | undefined | null) {
  if (!raw) return DEFAULT_REPORT_TIMES;
  const parts = raw
    .split(',')
    .map((p) => parseTime(p))
    .filter((p): p is string => Boolean(p));
  return parts.length ? Array.from(new Set(parts)) : DEFAULT_REPORT_TIMES;
}

function getTimeParts(timeZone: string): TimeParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const map = new Map(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.get('year') ?? 0),
    month: Number(map.get('month') ?? 0),
    day: Number(map.get('day') ?? 0),
    hour: Number(map.get('hour') ?? 0),
    minute: Number(map.get('minute') ?? 0),
  };
}

function formatDateKey(parts: TimeParts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function formatTimeKey(parts: TimeParts) {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function formatDateTime(ts: number, timeZone: string) {
  return new Date(ts).toLocaleString('ru-RU', { timeZone });
}

type ReportRange = { sinceMs: number; untilMs: number };

type ReportStats = {
  events: number;
  assists: number;
  errors: number;
  timeouts: number;
  emptyMessages: number;
  ragFacts: number;
  chatAssists: number;
  analyticsAssists: number;
  slowReplies: number;
  totalLatencyMs: number;
  latencySamples: number[];
  tabs: Map<string, number>;
  eventTypes: Map<string, number>;
  fieldDurations: Map<string, { total: number; count: number }>;
  fieldIdle: Map<string, { total: number; count: number }>;
  users: Map<string, number>;
};

function initStats(): ReportStats {
  return {
    events: 0,
    assists: 0,
    errors: 0,
    timeouts: 0,
    emptyMessages: 0,
    ragFacts: 0,
    chatAssists: 0,
    analyticsAssists: 0,
    slowReplies: 0,
    totalLatencyMs: 0,
    latencySamples: [],
    tabs: new Map(),
    eventTypes: new Map(),
    fieldDurations: new Map(),
    fieldIdle: new Map(),
    users: new Map(),
  };
}

function inc(map: Map<string, number>, key: string) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function addMetric(map: Map<string, { total: number; count: number }>, key: string, value: number) {
  if (!key || !Number.isFinite(value)) return;
  const entry = map.get(key) ?? { total: 0, count: 0 };
  entry.total += value;
  entry.count += 1;
  map.set(key, entry);
}

function topEntries(map: Map<string, number>, limit = 5) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function topMetrics(map: Map<string, { total: number; count: number }>, limit = 5, minCount = 2) {
  return Array.from(map.entries())
    .filter(([, v]) => v.count >= minCount)
    .map(([k, v]) => [k, v.total / v.count, v.count] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function parseSnapshotPayload(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadSnapshots(range: ReportRange) {
  const scopes = ['ai_agent_event', 'ai_agent_assist', 'ai_agent_assist_error', 'ai_agent_metrics', 'ai_agent_rag_fact'];
  const res = await pool.query(
    `select scope, payload_json, created_at
       from diagnostics_snapshots
      where scope = any($1)
        and created_at >= $2
        and created_at <= $3
      order by created_at desc
      limit $4`,
    [scopes, range.sinceMs, range.untilMs, MAX_SNAPSHOT_ROWS],
  );
  return res.rows ?? [];
}

function buildStats(rows: Array<{ scope: string; payload_json: string | null }>) {
  const stats = initStats();
  for (const row of rows) {
    const payload = parseSnapshotPayload(row.payload_json);
    if (!payload) continue;
    const actorId = String(payload.actorId ?? '');
    if (actorId) inc(stats.users, actorId);

    if (row.scope === 'ai_agent_event') {
      stats.events += 1;
      const event = payload.event ?? {};
      const tab = String(event.tab ?? payload.context?.tab ?? '');
      const type = String(event.type ?? '');
      const fieldLabel = String(event.field?.label ?? event.field?.name ?? '');
      inc(stats.tabs, tab);
      inc(stats.eventTypes, type);
      if (fieldLabel) {
        addMetric(stats.fieldDurations, fieldLabel, Number(event.durationMs ?? NaN));
        addMetric(stats.fieldIdle, fieldLabel, Number(event.idleMs ?? NaN));
      }
      continue;
    }

    if (row.scope === 'ai_agent_assist') {
      stats.assists += 1;
      const tab = String(payload.context?.tab ?? '');
      inc(stats.tabs, tab);
      const msg = String(payload.message ?? '');
      if (msg.trim().length < 3) stats.emptyMessages += 1;
      const mode = String(payload.mode ?? '');
      if (mode === 'chat') stats.chatAssists += 1;
      if (mode === 'analytics') stats.analyticsAssists += 1;
      continue;
    }

    if (row.scope === 'ai_agent_assist_error') {
      stats.errors += 1;
      const err = String(payload.error ?? '').toLowerCase();
      if (err.includes('timeout')) stats.timeouts += 1;
      continue;
    }

    if (row.scope === 'ai_agent_metrics') {
      const mode = String(payload.mode ?? '');
      const totalMs = Number(payload.timings?.totalMs ?? NaN);
      if (mode === 'chat') stats.chatAssists += 1;
      if (mode === 'analytics') stats.analyticsAssists += 1;
      if (Number.isFinite(totalMs) && totalMs >= 0) {
        stats.totalLatencyMs += totalMs;
        stats.latencySamples.push(totalMs);
        stats.latencySamples.sort((a, b) => a - b);
        if (totalMs > 10_000) stats.slowReplies += 1;
      }
      if (payload.timeout === true) stats.timeouts += 1;
      continue;
    }

    if (row.scope === 'ai_agent_rag_fact') {
      stats.ragFacts += 1;
      continue;
    }
  }
  return stats;
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? null;
}

function buildReportText(range: ReportRange, stats: ReportStats, timeZone: string) {
  const lines: string[] = [];
  lines.push('[AI Agent] Отчет по использованию и качеству');
  lines.push(`Период: ${formatDateTime(range.sinceMs, timeZone)} — ${formatDateTime(range.untilMs, timeZone)}`);
  lines.push(`События: ${stats.events}, сообщения: ${stats.assists}, ошибки: ${stats.errors} (таймауты: ${stats.timeouts})`);
  lines.push(`Режимы: чат=${stats.chatAssists}, аналитика=${stats.analyticsAssists}, RAG-факты=${stats.ragFacts}`);
  if (stats.latencySamples.length) {
    const avg = stats.totalLatencyMs / Math.max(1, stats.latencySamples.length);
    const p50 = percentile(stats.latencySamples, 0.5);
    const p95 = percentile(stats.latencySamples, 0.95);
    lines.push(
      `Скорость: avg=${avg.toFixed(0)}мс, p50=${p50 ?? 'n/a'}мс, p95=${p95 ?? 'n/a'}мс, медленных(>10с)=${stats.slowReplies}`,
    );
  }
  if (stats.emptyMessages > 0) lines.push(`Короткие/пустые запросы: ${stats.emptyMessages}`);

  const topTabs = topEntries(stats.tabs, 5);
  if (topTabs.length) {
    lines.push(`Топ вкладок: ${topTabs.map(([k, v]) => `${k || '—'}=${v}`).join(', ')}`);
  }

  const topEvents = topEntries(stats.eventTypes, 5);
  if (topEvents.length) {
    lines.push(`Топ событий: ${topEvents.map(([k, v]) => `${k || '—'}=${v}`).join(', ')}`);
  }

  const slowFields = topMetrics(stats.fieldDurations, 5, 2);
  if (slowFields.length) {
    lines.push(
      `Долгий ввод: ${slowFields
        .map(([k, avg, count]) => `${k} (${avg.toFixed(1)}мс, n=${count})`)
        .join(', ')}`,
    );
  }

  const idleFields = topMetrics(stats.fieldIdle, 5, 2);
  if (idleFields.length) {
    lines.push(
      `Простои на полях: ${idleFields.map(([k, avg, count]) => `${k} (${avg.toFixed(1)}мс, n=${count})`).join(', ')}`,
    );
  }

  const topUsers = topEntries(stats.users, 3);
  if (topUsers.length) {
    lines.push(`Активные пользователи (по событиям): ${topUsers.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  if (stats.errors > 0 || slowFields.length > 0 || idleFields.length > 0 || stats.emptyMessages > 0) {
    lines.push('Рекомендации:');
    if (stats.errors > 0) lines.push('- Проверить стабильность Ollama/AI‑агента (есть ошибки/таймауты).');
    if (stats.latencySamples.length > 0) {
      const p50 = percentile(stats.latencySamples, 0.5) ?? 0;
      const p95 = percentile(stats.latencySamples, 0.95) ?? 0;
      if (p50 > 4000 || p95 > 10_000) {
        lines.push('- Подкрутить low-latency профиль чата (ограничить контекст, num_predict, тайм-ауты стадий).');
      }
    }
    if (slowFields.length > 0 || idleFields.length > 0) lines.push('- Упростить/подсказать заполнение проблемных полей.');
    if (stats.emptyMessages > 0) lines.push('- Добавить подсказку пользователям о формате запроса в чат.');
    if (stats.ragFacts < 10) lines.push('- Увеличить поток RAG-фактов (контекстные события/успешные ответы) для более персональных подсказок.');
  }

  return lines.slice(0, MAX_REPORT_LINES).join('\n');
}

async function sendReportToSuperadmin(text: string) {
  const superadminId = await getSuperadminUserId();
  if (!superadminId) return;
  const aiAgentId = await getUserIdByLogin('ai-agent');
  const ts = nowMs();
  const id = randomUUID();
  const senderId = aiAgentId ?? superadminId;
  const senderName = aiAgentId ? 'ai-agent' : 'system';
  await db.insert(chatMessages).values({
    id,
    senderUserId: senderId as any,
    senderUsername: senderName,
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
    sender_user_id: String(senderId),
    sender_username: senderName,
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

async function getUserIdByLogin(login: string) {
  const list = await listEmployeesAuth().catch(() => null);
  if (!list || !list.ok) return null;
  const target = String(login ?? '').trim().toLowerCase();
  const row = list.rows.find((r) => String(r.login ?? '').trim().toLowerCase() === target);
  return row?.id ? String(row.id) : null;
}

export function startAiAgentReportsScheduler(args?: { times?: string[]; timeZone?: string }) {
  const timeZone = args?.timeZone || String(process.env.AI_REPORT_TZ ?? DEFAULT_TIME_ZONE);
  const times = args?.times?.length ? args.times : parseReportTimes(process.env.AI_REPORT_TIMES);
  const lastSentBySlot = new Map<string, string>();
  const lastReportAtBySlot = new Map<string, number>();

  const tick = async () => {
    try {
      const parts = getTimeParts(timeZone);
      const dateKey = formatDateKey(parts);
      const timeKey = formatTimeKey(parts);
      if (!times.includes(timeKey)) return;
      if (lastSentBySlot.get(timeKey) === dateKey) return;

      const untilMs = nowMs();
      const sinceMs = lastReportAtBySlot.get(timeKey) ?? untilMs - 12 * 60 * 60_000;
      const range = { sinceMs, untilMs };
      const rows = await loadSnapshots(range);
      const stats = buildStats(rows as any);
      const text = buildReportText(range, stats, timeZone);
      await sendReportToSuperadmin(text);
      lastSentBySlot.set(timeKey, dateKey);
      lastReportAtBySlot.set(timeKey, untilMs);
      logInfo('ai agent report sent', { timeKey, dateKey, sinceMs, untilMs });
    } catch (e) {
      logError('ai agent report failed', { error: String(e) });
    }
  };

  void tick();
  setInterval(() => void tick(), REPORT_TICK_MS);
}
