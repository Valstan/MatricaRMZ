import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { auditLog, clientSettings, statisticsActiveTime, statisticsAuditDaily, statisticsAuditEvents } from '../database/schema.js';
import { listEmployeesAuth } from './employeeAuthService.js';
import { getInstanceRole, shouldRunBackgroundJobs } from './instanceRole.js';
import { logError, logInfo } from '../utils/logger.js';

type ActionType = 'create' | 'update' | 'delete' | 'session' | 'other';
type DailySummaryRow = {
  login: string;
  fullName: string;
  onlineMs: number;
  onlineHours: number;
  activeMs: number;
  activeHours: number;
  created: number;
  updated: number;
  deleted: number;
  totalChanged: number;
};

let schedulerStarted = false;
let schedulerRunning = false;
let lastRequestAt = Date.now();
let lastRunAt = 0;
let lastRunStartedAt: number | null = null;
let lastRunFinishedAt: number | null = null;
let lastRunDurationMs: number | null = null;
let lastRunProcessedRows = 0;
let lastRunError: string | null = null;
let totalProcessedRows = 0;
const runDurationsMs: number[] = [];
const lagSamples: Array<{ at: number; value: number }> = [];
const queueSamples: Array<{ at: number; value: number }> = [];
const durationSamples: Array<{ at: number; value: number }> = [];

function nowMs() {
  return Date.now();
}

function pushSample(target: Array<{ at: number; value: number }>, at: number, value: number) {
  const last = target[target.length - 1];
  if (!last || at - last.at >= 15_000) {
    target.push({ at, value: Math.max(0, Math.round(value)) });
    if (target.length > 240) target.splice(0, target.length - 240);
  } else {
    last.at = at;
    last.value = Math.max(0, Math.round(value));
  }
}

function parsePayload(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function getMoscowDatePartsAtEpoch(epochMs: number) {
  const shifted = new Date(epochMs + 3 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function moscowDayStartMs(year: number, month: number, day: number, hour = 0) {
  return Date.UTC(year, month - 1, day, hour, 0, 0, 0) - 3 * 60 * 60 * 1000;
}

function sectionOf(actionRaw: string) {
  const action = String(actionRaw ?? '').toLowerCase();
  if (action.startsWith('app.session.')) return 'Сессия приложения';
  if (action.startsWith('auth.')) return 'Авторизация';
  if (action.startsWith('ui.supply_request.') || action.startsWith('supply_request.')) return 'Заявки';
  if (action.startsWith('ui.engine.') || action.startsWith('engine.')) return 'Двигатели';
  if (action.startsWith('part.')) return 'Детали';
  if (action.startsWith('tool.')) return 'Инструменты';
  if (action.startsWith('employee.')) return 'Сотрудники';
  if (action.startsWith('masterdata.') || action.startsWith('admin:')) return 'Справочники';
  if (action.startsWith('sync.')) return 'Синхронизация';
  if (action.startsWith('files.')) return 'Файлы';
  return 'Прочее';
}

function classifyActionType(actionRaw: string): ActionType {
  const action = String(actionRaw ?? '').toLowerCase();
  if (action.startsWith('app.session.')) return 'session';
  if (action.includes('.delete') || action.endsWith('_delete') || action.includes('soft_delete')) return 'delete';
  if (action.includes('.create') || action.endsWith('_create')) return 'create';
  if (
    action.includes('.update') ||
    action.includes('.edit') ||
    action.includes('.set_attr') ||
    action.includes('.upsert') ||
    action.includes('.transition') ||
    action.includes('.post') ||
    action.includes('.approve')
  ) {
    return 'update';
  }
  return 'other';
}

function actionText(actionRaw: string, payload: any): string {
  const action = String(actionRaw ?? '');
  if (action === 'app.session.start') return 'Включил программу';
  if (action === 'app.session.stop') return 'Выключил программу';
  if (action === 'ui.engine.edit_done') {
    return payload?.summaryRu ? `Изменил карточку двигателя. ${String(payload.summaryRu)}` : 'Изменил карточку двигателя';
  }
  if (action === 'ui.supply_request.edit_done') {
    return payload?.summaryRu ? `Изменил заявку. ${String(payload.summaryRu)}` : 'Изменил заявку';
  }
  if (action === 'engine.create') return 'Создал двигатель';
  if (action === 'part.create') return 'Создал деталь';
  if (action === 'part.delete') return 'Удалил деталь';
  if (action === 'supply_request.create') return 'Создал заявку';
  if (action === 'supply_request.delete') return 'Удалил заявку';
  if (action === 'supply_request.transition') {
    if (payload?.fromStatus && payload?.toStatus) return `Изменил статус заявки: ${String(payload.fromStatus)} -> ${String(payload.toStatus)}`;
    return 'Изменил статус заявки';
  }
  const t = classifyActionType(action);
  if (t === 'create') return 'Создал запись';
  if (t === 'update') return 'Изменил запись';
  if (t === 'delete') return 'Удалил запись';
  return action;
}

function docLabel(payload: any, section: string) {
  if (payload?.requestNumber) return `Заявка ${String(payload.requestNumber)}`;
  if (payload?.engineNumber) return `Двигатель ${String(payload.engineNumber)}`;
  if (payload?.name && section === 'Детали') return `Деталь ${String(payload.name)}`;
  if (payload?.docNo) return String(payload.docNo);
  return '';
}

function parseDateInput(raw: string | undefined): Date {
  const fallback = getMoscowDatePartsAtEpoch(nowMs());
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
  if (!m) return new Date(moscowDayStartMs(fallback.year, fallback.month, fallback.day));
  return new Date(moscowDayStartMs(Number(m[1]), Number(m[2]), Number(m[3])));
}

function startOfDayMs(date: Date) {
  const parts = getMoscowDatePartsAtEpoch(date.getTime());
  return moscowDayStartMs(parts.year, parts.month, parts.day);
}

function dayAtHourMs(date: Date, hour: number) {
  const parts = getMoscowDatePartsAtEpoch(date.getTime());
  return moscowDayStartMs(parts.year, parts.month, parts.day, hour);
}

function dayIso(date: Date) {
  const { year, month, day } = getMoscowDatePartsAtEpoch(date.getTime());
  const y = year;
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatHours(ms: number) {
  return Math.max(0, Math.round((ms / (60 * 60 * 1000)) * 100) / 100);
}

async function ingestAuditBatch(batchSize: number, overlapMs: number): Promise<number> {
  const maxRow = await db
    .select({ maxCreatedAt: sql<number>`coalesce(max(${statisticsAuditEvents.createdAt}), 0)` })
    .from(statisticsAuditEvents)
    .limit(1);
  const maxCreatedAt = Number(maxRow[0]?.maxCreatedAt ?? 0);
  const fromMs = Math.max(0, maxCreatedAt - overlapMs);
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(isNull(auditLog.deletedAt), gte(auditLog.createdAt, fromMs)))
    .orderBy(asc(auditLog.createdAt))
    .limit(batchSize);
  if (rows.length === 0) return 0;
  const mapped = rows.map((row) => {
    const payload = parsePayload(row.payloadJson);
    const section = sectionOf(row.action);
    return {
      sourceAuditId: row.id,
      createdAt: Number(row.createdAt),
      actor: String(row.actor ?? ''),
      action: String(row.action ?? ''),
      actionType: classifyActionType(row.action),
      section,
      actionText: actionText(row.action, payload),
      documentLabel: docLabel(payload, section),
      clientId: payload?.clientId ? String(payload.clientId) : null,
      tableName: row.tableName ? String(row.tableName) : null,
      processedAt: nowMs(),
    };
  });
  await db.insert(statisticsAuditEvents).values(mapped).onConflictDoNothing({ target: statisticsAuditEvents.sourceAuditId });
  return rows.length;
}

export type SessionEvent = { at: number; action: string };

/**
 * Connected («Онлайн») time of one actor's sessions inside [windowStart, windowEnd].
 * Sessions come from `app.session.start` / `app.session.stop` audit events (nesting-counted).
 * An UNCLOSED session (no stop — e.g. the client is still open, or crashed) ends at the last
 * heartbeat (`lastSeenAt + graceMs`), NOT at the window edge — so a just-opened client reads ~0
 * instead of inflating to the work-window end (the old «10 ч 00 мин» bug). Pure + unit-tested.
 */
export function sessionizeOnlineMs(
  events: SessionEvent[],
  opts: { windowStart: number; windowEnd: number; lastSeenAt: number; graceMs: number },
): number {
  const { windowStart, windowEnd, lastSeenAt, graceMs } = opts;
  if (windowEnd <= windowStart) return 0;
  const sorted = [...events].sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.action === b.action) return 0;
    return a.action === 'app.session.start' ? -1 : 1;
  });
  // How long we can prove the client was alive for an open session.
  const openEnd = lastSeenAt > 0 ? Math.min(windowEnd, lastSeenAt + graceMs) : windowEnd;

  let total = 0;
  let depth = 0;
  let segStart: number | null = null;
  for (const ev of sorted) {
    if (ev.action === 'app.session.start') {
      if (depth === 0) {
        const start = Math.max(windowStart, ev.at);
        segStart = start < windowEnd ? start : null;
      }
      depth += 1;
    } else if (ev.action === 'app.session.stop') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && segStart != null) {
          const end = Math.min(windowEnd, ev.at);
          if (end > segStart) total += end - segStart;
          segStart = null;
        }
      }
    }
  }
  if (segStart != null && openEnd > segStart) total += openEnd - segStart;

  const DAY_MS = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.min(total, DAY_MS));
}

async function recomputeDailySummary(dateValue: Date, cutoffHour: number) {
  // Окно дня: [00:00, min(now, cutoffHour:00)] МСК — для сегодня верхняя граница = «сейчас»,
  // чтобы открытая сессия не растягивалась до конца дня (старый баг «10 ч 00 мин»).
  const summaryDate = dayIso(dateValue);
  const isToday = summaryDate === dayIso(new Date());
  const rangeStart = startOfDayMs(dateValue);
  const cutoffMs = dayAtHourMs(dateValue, cutoffHour);
  const rangeEnd = isToday ? Math.min(nowMs(), cutoffMs) : cutoffMs;
  // Заглядываем на 14 часов назад, чтобы захватить сессии, начавшиеся до начала дня (ночная смена).
  const sessionFrom = rangeStart - 14 * 60 * 60 * 1000;
  const ONLINE_GRACE_MS = 2 * 60 * 1000;

  const [allRows, sessionRows] = await Promise.all([
    db
      .select()
      .from(statisticsAuditEvents)
      .where(and(gte(statisticsAuditEvents.createdAt, rangeStart), lte(statisticsAuditEvents.createdAt, rangeEnd)))
      .orderBy(desc(statisticsAuditEvents.createdAt))
      .limit(200_000),
    db
      .select()
      .from(statisticsAuditEvents)
      .where(and(gte(statisticsAuditEvents.createdAt, sessionFrom), lte(statisticsAuditEvents.createdAt, rangeEnd)))
      .orderBy(asc(statisticsAuditEvents.createdAt))
      .limit(200_000),
  ]);

  const list = await listEmployeesAuth().catch(() => null);
  const nameByLogin = new Map<string, string>();
  if (list?.ok) {
    for (const row of list.rows) {
      const login = String(row.login ?? '').trim().toLowerCase();
      if (!login) continue;
      nameByLogin.set(login, String(row.fullName ?? '').trim() || String(row.login ?? '').trim());
    }
  }

  const byActor = new Map<
    string,
    {
      login: string;
      fullName: string;
      created: number;
      updated: number;
      deleted: number;
      onlineMs: number;
      activeMs: number;
    }
  >();
  const ensureActor = (actorRaw: string) => {
    const login = String(actorRaw ?? '').trim();
    const key = login.toLowerCase();
    const existing = byActor.get(key);
    if (existing) return existing;
    const row = {
      login,
      fullName: nameByLogin.get(key) ?? login,
      created: 0,
      updated: 0,
      deleted: 0,
      onlineMs: 0,
      activeMs: 0,
    };
    byActor.set(key, row);
    return row;
  };

  for (const row of allRows) {
    const actor = ensureActor(row.actor);
    if (row.actionType === 'create') actor.created += 1;
    if (row.actionType === 'update') actor.updated += 1;
    if (row.actionType === 'delete') actor.deleted += 1;
  }

  const sessionEvents = sessionRows.filter((row) => {
    const action = String(row.action ?? '');
    return action === 'app.session.start' || action === 'app.session.stop';
  });
  const byActorSession = new Map<
    string,
    {
      actor: string;
      events: Array<{ at: number; action: string }>;
    }
  >();
  for (const row of sessionEvents) {
    const actor = String(row.actor ?? '').trim().toLowerCase();
    if (!actor) continue;
    const bucket =
      byActorSession.get(actor) ??
      ({
        actor: String(row.actor ?? '').trim(),
        events: [],
      } as { actor: string; events: Array<{ at: number; action: string }> });
    bucket.events.push({ at: Number(row.createdAt), action: String(row.action) });
    if (!bucket.actor) bucket.actor = String(row.actor ?? '').trim() || actor;
    byActorSession.set(actor, bucket);
  }

  // Последний heartbeat по логину (для ограничения открытых сессий) — client_settings.lastSeenAt.
  const lastSeenByLogin = new Map<string, number>();
  const seenRows = await db
    .select({ login: clientSettings.lastUsername, seen: clientSettings.lastSeenAt })
    .from(clientSettings);
  for (const r of seenRows) {
    const k = String(r.login ?? '').trim().toLowerCase();
    if (!k) continue;
    const v = Number(r.seen ?? 0);
    if (v > (lastSeenByLogin.get(k) ?? 0)) lastSeenByLogin.set(k, v);
  }

  for (const [key, payload] of byActorSession.entries()) {
    const actor = payload.actor || key;
    if (!actor) continue;
    const onlineMs = sessionizeOnlineMs(payload.events, {
      windowStart: rangeStart,
      windowEnd: rangeEnd,
      lastSeenAt: lastSeenByLogin.get(key) ?? 0,
      graceMs: ONLINE_GRACE_MS,
    });
    if (onlineMs > 0) ensureActor(actor).onlineMs += onlineMs;
  }

  // «Активное» время за день — сумма по логину из statistics_active_time (input-based, heartbeat-дельты).
  const activeRows = await db
    .select({ login: statisticsActiveTime.login, activeMs: statisticsActiveTime.activeMs })
    .from(statisticsActiveTime)
    .where(eq(statisticsActiveTime.summaryDate, summaryDate));
  for (const r of activeRows) {
    const key = String(r.login ?? '').trim().toLowerCase();
    if (!key) continue;
    ensureActor(key).activeMs += Math.max(0, Number(r.activeMs ?? 0));
  }

  const rows = Array.from(byActor.values())
    .filter((row) => row.login && (row.created + row.updated + row.deleted > 0 || row.onlineMs > 0 || row.activeMs > 0))
    .map((row) => ({
      login: row.login,
      fullName: row.fullName,
      onlineMs: row.onlineMs,
      activeMs: row.activeMs,
      created: row.created,
      updated: row.updated,
      deleted: row.deleted,
      totalChanged: row.created + row.updated + row.deleted,
    }));

  await db.delete(statisticsAuditDaily).where(and(eq(statisticsAuditDaily.summaryDate, summaryDate), eq(statisticsAuditDaily.cutoffHour, cutoffHour)));
  if (rows.length > 0) {
    const ts = nowMs();
    await db.insert(statisticsAuditDaily).values(
      rows.map((row) => ({
        id: randomUUID(),
        summaryDate,
        cutoffHour,
        login: row.login,
        fullName: row.fullName,
        onlineMs: row.onlineMs,
        activeMs: row.activeMs,
        createdCount: row.created,
        updatedCount: row.updated,
        deletedCount: row.deleted,
        totalChanged: row.totalChanged,
        generatedAt: ts,
      })),
    );
  }
}

export function noteStatisticsRequestActivity() {
  lastRequestAt = nowMs();
}

export async function collectAuditStatistics(args?: { maxBatches?: number; batchSize?: number }) {
  const maxBatches = Math.max(1, Number(args?.maxBatches ?? 3));
  const batchSize = Math.max(100, Math.min(5000, Number(args?.batchSize ?? 1000)));
  const overlapMs = Math.max(30_000, Number(process.env.MATRICA_STATS_AUDIT_OVERLAP_MS ?? 120_000));
  let processed = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const fetched = await ingestAuditBatch(batchSize, overlapMs);
    processed += fetched;
    if (fetched < batchSize) break;
  }
  return processed;
}

async function schedulerTick(force = false) {
  if (schedulerRunning) return;
  const now = nowMs();
  const minIdleMs = Math.max(5_000, Number(process.env.MATRICA_STATS_AUDIT_MIN_IDLE_MS ?? 45_000));
  const maxSkipMs = Math.max(60_000, Number(process.env.MATRICA_STATS_AUDIT_MAX_SKIP_MS ?? 15 * 60_000));
  if (!force && now - lastRequestAt < minIdleMs && now - lastRunAt < maxSkipMs) return;
  schedulerRunning = true;
  lastRunStartedAt = nowMs();
  lastRunError = null;
  try {
    const processed = await collectAuditStatistics({ maxBatches: 4, batchSize: 1500 });
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    await recomputeDailySummary(today, 21);
    await recomputeDailySummary(yesterday, 21);
    lastRunAt = nowMs();
    lastRunProcessedRows = processed;
    totalProcessedRows += processed;
  } catch (e) {
    lastRunError = String(e);
    logError('statistics audit scheduler tick failed', { error: lastRunError });
  } finally {
    lastRunFinishedAt = nowMs();
    lastRunDurationMs = lastRunStartedAt != null ? Math.max(0, lastRunFinishedAt - lastRunStartedAt) : null;
    if (lastRunDurationMs != null) {
      runDurationsMs.push(lastRunDurationMs);
      if (runDurationsMs.length > 20) runDurationsMs.splice(0, runDurationsMs.length - 20);
    }
    schedulerRunning = false;
  }
}

export function startAuditStatisticsScheduler() {
  const instanceRole = getInstanceRole();
  if (!shouldRunBackgroundJobs(instanceRole)) {
    logInfo('statistics audit scheduler skipped on non-primary instance', { instanceRole: instanceRole || 'primary' }, { critical: true });
    return;
  }

  if (schedulerStarted) return;
  schedulerStarted = true;
  const intervalMs = Math.max(30_000, Number(process.env.MATRICA_STATS_AUDIT_INTERVAL_MS ?? 180_000));
  setTimeout(() => void schedulerTick(true), 15_000);
  setInterval(() => void schedulerTick(false), intervalMs);
  logInfo('statistics audit scheduler started', { intervalMs });
}

export async function ensureAuditStatisticsWarm() {
  await collectAuditStatistics({ maxBatches: 1, batchSize: 1000 }).catch(() => {});
}

export async function getAuditStatisticsStatus() {
  const maxProcessedRow = await db
    .select({ maxCreatedAt: sql<number>`coalesce(max(${statisticsAuditEvents.createdAt}), 0)` })
    .from(statisticsAuditEvents)
    .limit(1);
  const maxProcessedCreatedAt = Number(maxProcessedRow[0]?.maxCreatedAt ?? 0);
  const now = nowMs();
  const lagMs = maxProcessedCreatedAt > 0 ? Math.max(0, now - maxProcessedCreatedAt) : null;
  const queueRow = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(auditLog)
    .where(and(isNull(auditLog.deletedAt), gte(auditLog.createdAt, maxProcessedCreatedAt)));
  const queueSize = Number(queueRow[0]?.cnt ?? 0);
  const avgDurationMs =
    runDurationsMs.length > 0 ? Math.round(runDurationsMs.reduce((acc, v) => acc + v, 0) / runDurationsMs.length) : null;
  const lagWarnMs = Math.max(30_000, Number(process.env.MATRICA_STATS_AUDIT_LAG_WARN_MS ?? 5 * 60_000));
  const lagCritMs = Math.max(lagWarnMs, Number(process.env.MATRICA_STATS_AUDIT_LAG_CRIT_MS ?? 15 * 60_000));
  const queueWarn = Math.max(10, Number(process.env.MATRICA_STATS_AUDIT_QUEUE_WARN ?? 1000));
  const queueCrit = Math.max(queueWarn, Number(process.env.MATRICA_STATS_AUDIT_QUEUE_CRIT ?? 5000));
  const durationWarnMs = Math.max(1000, Number(process.env.MATRICA_STATS_AUDIT_DURATION_WARN_MS ?? 60_000));
  const durationCritMs = Math.max(durationWarnMs, Number(process.env.MATRICA_STATS_AUDIT_DURATION_CRIT_MS ?? 180_000));

  if (lagMs != null) pushSample(lagSamples, now, lagMs);
  pushSample(queueSamples, now, queueSize);
  if (lastRunDurationMs != null && lastRunFinishedAt != null) pushSample(durationSamples, lastRunFinishedAt, lastRunDurationMs);

  const hasCritical =
    (lagMs != null && lagMs >= lagCritMs) ||
    queueSize >= queueCrit ||
    (lastRunDurationMs != null && lastRunDurationMs >= durationCritMs) ||
    !!lastRunError;
  const hasWarning =
    !hasCritical &&
    ((lagMs != null && lagMs >= lagWarnMs) || queueSize >= queueWarn || (lastRunDurationMs != null && lastRunDurationMs >= durationWarnMs));
  const health: 'ok' | 'warn' | 'critical' = hasCritical ? 'critical' : hasWarning ? 'warn' : 'ok';

  return {
    schedulerStarted,
    schedulerRunning,
    lastRequestAt,
    lastRunAt: lastRunAt || null,
    lastRunStartedAt,
    lastRunFinishedAt,
    lastRunDurationMs,
    lastRunProcessedRows,
    totalProcessedRows,
    lastRunError,
    maxProcessedCreatedAt: maxProcessedCreatedAt || null,
    lagMs,
    queueSize,
    avgDurationMs,
    lagSamples,
    queueSamples,
    durationSamples,
    thresholds: {
      lagWarnMs,
      lagCritMs,
      queueWarn,
      queueCrit,
      durationWarnMs,
      durationCritMs,
    },
    health,
    intervalMs: Math.max(30_000, Number(process.env.MATRICA_STATS_AUDIT_INTERVAL_MS ?? 180_000)),
    minIdleMs: Math.max(5_000, Number(process.env.MATRICA_STATS_AUDIT_MIN_IDLE_MS ?? 45_000)),
    maxSkipMs: Math.max(60_000, Number(process.env.MATRICA_STATS_AUDIT_MAX_SKIP_MS ?? 15 * 60_000)),
  };
}

export async function listAuditStatistics(args: {
  limit: number;
  fromMs?: number;
  toMs?: number;
  actor?: string;
  actionType?: ActionType;
}) {
  const filters = [];
  if (args.fromMs != null) filters.push(gte(statisticsAuditEvents.createdAt, args.fromMs));
  if (args.toMs != null) filters.push(lte(statisticsAuditEvents.createdAt, args.toMs));
  if (args.actor) filters.push(eq(statisticsAuditEvents.actor, args.actor));
  if (args.actionType) filters.push(eq(statisticsAuditEvents.actionType, args.actionType));

  const rows = await db
    .select({
      sourceAuditId: statisticsAuditEvents.sourceAuditId,
      createdAt: statisticsAuditEvents.createdAt,
      actor: statisticsAuditEvents.actor,
      action: statisticsAuditEvents.action,
      actionType: statisticsAuditEvents.actionType,
      section: statisticsAuditEvents.section,
      actionText: statisticsAuditEvents.actionText,
      documentLabel: statisticsAuditEvents.documentLabel,
      clientId: statisticsAuditEvents.clientId,
      tableName: statisticsAuditEvents.tableName,
      entityId: auditLog.entityId,
    })
    .from(statisticsAuditEvents)
    .leftJoin(auditLog, eq(auditLog.id, statisticsAuditEvents.sourceAuditId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(statisticsAuditEvents.createdAt))
    .limit(args.limit);
  return rows.map((row) => ({
    id: row.sourceAuditId,
    createdAt: Number(row.createdAt),
    actor: row.actor,
    action: row.action,
    actionType: row.actionType as ActionType,
    section: row.section,
    actionText: row.actionText,
    documentLabel: row.documentLabel ?? '',
    clientId: row.clientId ?? null,
    tableName: row.tableName ?? null,
    entityId: row.entityId ?? null,
  }));
}

export async function getDailyAuditStatistics(args: { date?: string; cutoffHour?: number }) {
  const day = parseDateInput(args.date);
  const cutoffHour = args.cutoffHour ?? 21;
  const summaryDate = dayIso(day);
  const rangeStart = startOfDayMs(day);
  const rangeEnd = dayAtHourMs(day, cutoffHour);

  let rows = await db
    .select()
    .from(statisticsAuditDaily)
    .where(and(eq(statisticsAuditDaily.summaryDate, summaryDate), eq(statisticsAuditDaily.cutoffHour, cutoffHour)))
    .orderBy(asc(statisticsAuditDaily.login));

  const isToday = summaryDate === dayIso(new Date());
  const stale = rows.length === 0 || (isToday && rows.some((r) => Number(r.generatedAt ?? 0) < nowMs() - 10 * 60_000));
  if (stale) {
    await recomputeDailySummary(day, cutoffHour);
    rows = await db
      .select()
      .from(statisticsAuditDaily)
      .where(and(eq(statisticsAuditDaily.summaryDate, summaryDate), eq(statisticsAuditDaily.cutoffHour, cutoffHour)))
      .orderBy(asc(statisticsAuditDaily.login));
  }

  const mapped: DailySummaryRow[] = rows.map((row) => ({
    login: row.login,
    fullName: row.fullName,
    onlineMs: Number(row.onlineMs ?? 0),
    onlineHours: formatHours(Number(row.onlineMs ?? 0)),
    activeMs: Number(row.activeMs ?? 0),
    activeHours: formatHours(Number(row.activeMs ?? 0)),
    created: Number(row.createdCount ?? 0),
    updated: Number(row.updatedCount ?? 0),
    deleted: Number(row.deletedCount ?? 0),
    totalChanged: Number(row.totalChanged ?? 0),
  }));

  return { rangeStart, rangeEnd, cutoffHour, rows: mapped };
}
