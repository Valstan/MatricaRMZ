import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { auditLog, statisticsAuditDaily, statisticsAuditEvents } from '../database/schema.js';
import { listEmployeesAuth } from './employeeAuthService.js';
import { logError, logInfo } from '../utils/logger.js';

type ActionType = 'create' | 'update' | 'delete' | 'session' | 'other';
type DailySummaryRow = {
  login: string;
  fullName: string;
  onlineMs: number;
  onlineHours: number;
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
  if (!raw) return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

function startOfDayMs(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime();
}

function dayAtHourMs(date: Date, hour: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0, 0).getTime();
}

function dayIso(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
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

async function recomputeDailySummary(dateValue: Date, cutoffHour: number) {
  const rangeStart = startOfDayMs(dateValue);
  const rangeEnd = dayAtHourMs(dateValue, cutoffHour);
  const sessionFrom = rangeStart - 24 * 60 * 60 * 1000;
  const summaryDate = dayIso(dateValue);

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
  const byActorClient = new Map<string, Array<{ at: number; action: string }>>();
  for (const row of sessionEvents) {
    const clientId = String(row.clientId ?? 'unknown');
    const actor = String(row.actor ?? '').trim().toLowerCase();
    const key = `${actor}::${clientId}`;
    const listForKey = byActorClient.get(key) ?? [];
    listForKey.push({ at: Number(row.createdAt), action: String(row.action) });
    byActorClient.set(key, listForKey);
  }

  const clipAdd = (actor: string, startAt: number, endAt: number) => {
    const start = Math.max(rangeStart, startAt);
    const end = Math.min(rangeEnd, endAt);
    if (end <= start) return;
    ensureActor(actor).onlineMs += end - start;
  };
  for (const [key, events] of byActorClient.entries()) {
    const actor = key.split('::')[0] ?? '';
    if (!actor) continue;
    let openAt: number | null = null;
    for (const event of events) {
      if (event.action === 'app.session.start') {
        if (openAt != null) clipAdd(actor, openAt, event.at);
        openAt = event.at;
      } else if (event.action === 'app.session.stop') {
        if (openAt != null) {
          clipAdd(actor, openAt, event.at);
          openAt = null;
        }
      }
    }
    if (openAt != null) clipAdd(actor, openAt, rangeEnd);
  }

  const rows = Array.from(byActor.values())
    .filter((row) => row.login && (row.created + row.updated + row.deleted > 0 || row.onlineMs > 0))
    .map((row) => ({
      login: row.login,
      fullName: row.fullName,
      onlineMs: row.onlineMs,
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
    .select()
    .from(statisticsAuditEvents)
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
    created: Number(row.createdCount ?? 0),
    updated: Number(row.updatedCount ?? 0),
    deleted: Number(row.deletedCount ?? 0),
    totalChanged: Number(row.totalChanged ?? 0),
  }));

  return { rangeStart, rangeEnd, cutoffHour, rows: mapped };
}
