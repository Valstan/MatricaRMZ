import { randomUUID, createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { clientSettings, diagnosticsSnapshots } from '../database/schema.js';
import { getConsistencyReport, type ConsistencyClientReport } from './diagnosticsConsistencyService.js';
import { setClientSyncRequest } from './clientSettingsService.js';
import { logError, logInfo } from '../utils/logger.js';

type AutohealAction = 'force_full_pull_v2' | 'reset_sync_state_and_pull' | 'deep_repair';
type AutohealSignalLevel = 'normal' | 'observe' | 'degraded' | 'critical';

type AutohealSignal = {
  kind: 'autoheal_signal';
  at: number;
  level: AutohealSignalLevel;
  fingerprint: string;
  driftCount: number;
  warningCount: number;
  unknownCount: number;
  totalComparable: number;
  driftRatio: number;
  warningRatio: number;
  lagAbs: number;
  lagRatio: number;
};

type AutohealActionAudit = {
  kind: 'autoheal';
  at: number;
  action: 'enqueue' | 'skip';
  requestType?: AutohealAction;
  reason?: string;
  fingerprint?: string;
};

function nowMs() {
  return Date.now();
}

function isAutohealEnabled() {
  return String(process.env.MATRICA_SYNC_AUTOHEAL_ENABLED ?? '1').trim() !== '0';
}

function autohealCooldownMs() {
  const raw = Number(process.env.MATRICA_SYNC_AUTOHEAL_COOLDOWN_MS ?? 15 * 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}

function sameFingerprintCooldownMs() {
  const raw = Number(process.env.MATRICA_SYNC_AUTOHEAL_SAME_FINGERPRINT_COOLDOWN_MS ?? 6 * 60 * 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60_000;
}

function driftThresholdCount() {
  const raw = Number(process.env.MATRICA_SYNC_DRIFT_THRESHOLD ?? 2);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

function n(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dailyActionBudget() {
  return Math.max(1, Math.floor(n(process.env.MATRICA_SYNC_AUTOHEAL_MAX_ACTIONS_PER_24H, 3)));
}

function deepRepairBudget() {
  return Math.max(1, Math.floor(n(process.env.MATRICA_SYNC_AUTOHEAL_MAX_DEEP_REPAIR_PER_24H, 1)));
}

function observeThresholdRatio() {
  return Math.max(0.01, Math.min(0.95, n(process.env.MATRICA_SYNC_AUTOHEAL_OBSERVE_RATIO, 0.08)));
}

function degradedThresholdRatio() {
  return Math.max(0.01, Math.min(0.95, n(process.env.MATRICA_SYNC_AUTOHEAL_DEGRADED_RATIO, 0.15)));
}

function criticalThresholdRatio() {
  return Math.max(0.01, Math.min(0.95, n(process.env.MATRICA_SYNC_AUTOHEAL_CRITICAL_RATIO, 0.35)));
}

function resetConsecutiveThreshold() {
  return Math.max(2, Math.floor(n(process.env.MATRICA_SYNC_AUTOHEAL_RESET_CONSECUTIVE, 4)));
}

function criticalConsecutiveThreshold() {
  return Math.max(2, Math.floor(n(process.env.MATRICA_SYNC_AUTOHEAL_CRITICAL_CONSECUTIVE, 2)));
}

function forceFullPullConsecutiveThreshold() {
  return Math.max(4, Math.floor(n(process.env.MATRICA_SYNC_AUTOHEAL_FORCE_PULL_CONSECUTIVE, 8)));
}

function levelWeight(level: AutohealSignalLevel) {
  switch (level) {
    case 'normal':
      return 0;
    case 'observe':
      return 1;
    case 'degraded':
      return 2;
    case 'critical':
      return 3;
  }
}

function compareAtLeast(level: AutohealSignalLevel, minimum: AutohealSignalLevel) {
  return levelWeight(level) >= levelWeight(minimum);
}

function consecutiveAtLeast(signals: AutohealSignal[], minimum: AutohealSignalLevel) {
  let count = 0;
  for (const signal of signals) {
    if (!compareAtLeast(signal.level, minimum)) break;
    count += 1;
  }
  return count;
}

function chooseSignal(report: ConsistencyClientReport, serverSeq: number | null) {
  const driftCount = report.diffs.filter((d) => d.status === 'drift').length;
  const warningCount = report.diffs.filter((d) => d.status === 'warning').length;
  const unknownCount = report.diffs.filter((d) => d.status === 'unknown').length;
  const comparable = report.diffs.filter((d) => d.status !== 'unknown').length;
  const totalComparable = Math.max(1, comparable);
  const driftRatio = driftCount / totalComparable;
  const warningRatio = warningCount / totalComparable;
  const mismatchCount = driftCount + warningCount;
  const mismatchRatio = mismatchCount / totalComparable;
  const lag = Math.max(0, Number(serverSeq ?? 0) - Number(report.lastPulledServerSeq ?? 0));
  const lagRatio = Number(serverSeq ?? 0) > 0 ? lag / Number(serverSeq ?? 1) : 0;

  let level: AutohealSignalLevel = 'normal';
  // Best-practice policy: don't heal on single warning blips, escalate only on clear error budgets burn.
  if (
    driftRatio >= criticalThresholdRatio() ||
    driftCount >= Math.max(8, driftThresholdCount() * 3) ||
    (lag > 25_000 && lagRatio >= 0.25 && mismatchRatio >= Math.max(0.08, observeThresholdRatio()))
  ) {
    level = 'critical';
  } else if (
    driftRatio >= degradedThresholdRatio() ||
    driftCount >= Math.max(4, driftThresholdCount() * 2) ||
    (lag > 12_000 && mismatchRatio >= observeThresholdRatio())
  ) {
    level = 'degraded';
  } else if (
    driftRatio >= observeThresholdRatio() ||
    warningRatio >= 0.3 ||
    warningCount >= Math.max(6, driftThresholdCount() * 3) ||
    (lag > 5000 && mismatchCount > 0)
  ) {
    level = 'observe';
  }

  return {
    kind: 'autoheal_signal' as const,
    at: nowMs(),
    level,
    fingerprint: buildFingerprint(report),
    driftCount,
    warningCount,
    unknownCount,
    totalComparable,
    driftRatio,
    warningRatio,
    lagAbs: lag,
    lagRatio,
  };
}

function buildFingerprint(report: ConsistencyClientReport) {
  const raw = report.diffs
    .filter((d) => d.status === 'drift' || d.status === 'warning')
    .map((d) => `${d.kind}:${d.name}:${d.status}`)
    .sort()
    .join('|');
  return createHash('sha1').update(raw || 'empty').digest('hex');
}

function parseJson(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

async function saveDiagnosticsPayload(clientId: string, payload: Record<string, unknown>) {
  try {
    await db.insert(diagnosticsSnapshots).values({
      id: randomUUID(),
      scope: 'server',
      clientId,
      payloadJson: JSON.stringify({
        kind: 'autoheal',
        at: nowMs(),
        ...payload,
      }),
      createdAt: nowMs(),
    });
  } catch (e) {
    logError('autoheal diagnostics insert failed', { clientId, error: String(e) });
  }
}

async function auditAutohealEvent(clientId: string, payload: Record<string, unknown>) {
  await saveDiagnosticsPayload(clientId, {
    kind: 'autoheal',
    at: nowMs(),
    ...payload,
  });
}

async function saveAutohealSignal(clientId: string, signal: AutohealSignal) {
  await saveDiagnosticsPayload(clientId, signal);
}

async function loadRecentAutoheal(clientId: string) {
  const rows = await db
    .select({ payloadJson: diagnosticsSnapshots.payloadJson, createdAt: diagnosticsSnapshots.createdAt })
    .from(diagnosticsSnapshots)
    .where(and(eq(diagnosticsSnapshots.scope, 'server'), eq(diagnosticsSnapshots.clientId, clientId)))
    .orderBy(desc(diagnosticsSnapshots.createdAt))
    .limit(200);
  const signals: AutohealSignal[] = [];
  const actions: Array<AutohealActionAudit & { createdAt: number }> = [];
  for (const row of rows as any[]) {
    const payload = parseJson(row?.payloadJson);
    if (!payload || typeof payload !== 'object') continue;
    const kind = String((payload as any).kind ?? '');
    if (kind === 'autoheal_signal') {
      const levelRaw = String((payload as any).level ?? '');
      if (!['normal', 'observe', 'degraded', 'critical'].includes(levelRaw)) continue;
      signals.push({
        kind: 'autoheal_signal',
        at: Number((payload as any).at ?? row.createdAt ?? 0),
        level: levelRaw as AutohealSignalLevel,
        fingerprint: String((payload as any).fingerprint ?? ''),
        driftCount: Number((payload as any).driftCount ?? 0),
        warningCount: Number((payload as any).warningCount ?? 0),
        unknownCount: Number((payload as any).unknownCount ?? 0),
        totalComparable: Number((payload as any).totalComparable ?? 1),
        driftRatio: Number((payload as any).driftRatio ?? 0),
        warningRatio: Number((payload as any).warningRatio ?? 0),
        lagAbs: Number((payload as any).lagAbs ?? 0),
        lagRatio: Number((payload as any).lagRatio ?? 0),
      });
      continue;
    }
    if (kind === 'autoheal') {
      const requestTypeRaw = (payload as any).requestType;
      const reasonRaw = (payload as any).reason;
      const fpRaw = (payload as any).fingerprint;
      actions.push({
        kind: 'autoheal',
        at: Number((payload as any).at ?? row.createdAt ?? 0),
        action: String((payload as any).action ?? 'skip') === 'enqueue' ? 'enqueue' : 'skip',
        ...(requestTypeRaw ? { requestType: requestTypeRaw as AutohealAction } : {}),
        ...(reasonRaw ? { reason: String(reasonRaw) } : {}),
        ...(fpRaw ? { fingerprint: String(fpRaw) } : {}),
        createdAt: Number(row?.createdAt ?? 0),
      });
    }
  }
  return { signals, actions };
}

function chooseAction(signal: AutohealSignal, history: AutohealSignal[]): AutohealAction | null {
  const chain = [signal, ...history];
  const criticalStreak = consecutiveAtLeast(chain, 'critical');
  const degradedStreak = consecutiveAtLeast(chain, 'degraded');
  const observeStreak = consecutiveAtLeast(chain, 'observe');

  if (signal.level === 'critical' && criticalStreak >= criticalConsecutiveThreshold()) return 'deep_repair';
  if (compareAtLeast(signal.level, 'degraded') && degradedStreak >= resetConsecutiveThreshold()) {
    return 'reset_sync_state_and_pull';
  }
  if (signal.level === 'observe' && observeStreak >= forceFullPullConsecutiveThreshold() && signal.lagAbs > 8000) {
    return 'force_full_pull_v2';
  }
  return null;
}

export async function evaluateAutohealForClient(clientId: string) {
  if (!isAutohealEnabled()) return { queued: false as const, reason: 'disabled' };
  try {
    const reportAll = await getConsistencyReport();
    const report = reportAll.clients.find((c) => c.clientId === clientId) ?? null;
    if (!report) return { queued: false as const, reason: 'no_report' };
    if (reportAll.server?.source === 'unknown') {
      await auditAutohealEvent(clientId, { action: 'skip', reason: 'server_snapshot_unknown' });
      return { queued: false as const, reason: 'server_snapshot_unknown' };
    }
    const signal = chooseSignal(report, reportAll.server?.serverSeq ?? null);
    await saveAutohealSignal(clientId, signal);
    const history = await loadRecentAutoheal(clientId);
    const priorSignals = history.signals.filter((s) => s.at < signal.at).slice(0, 50);
    const action = chooseAction(signal, priorSignals);
    if (!action) {
      await auditAutohealEvent(clientId, {
        action: 'skip',
        reason: signal.level === 'normal' ? 'status_ok' : 'below_action_threshold',
        level: signal.level,
        driftRatio: signal.driftRatio,
        lagAbs: signal.lagAbs,
      });
      return { queued: false as const, reason: signal.level === 'normal' ? 'status_ok' : 'below_action_threshold' };
    }

    const row = (await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1))[0] ?? null;
    const cooldown = autohealCooldownMs();
    const now = nowMs();
    if (row?.syncRequestType) {
      await auditAutohealEvent(clientId, { action: 'skip', reason: 'pending_request', requestType: row.syncRequestType });
      return { queued: false as const, reason: 'pending_request' };
    }
    if (row?.syncRequestAt && now - Number(row.syncRequestAt) < cooldown) {
      await auditAutohealEvent(clientId, { action: 'skip', reason: 'cooldown', syncRequestAt: Number(row.syncRequestAt) });
      return { queued: false as const, reason: 'cooldown' };
    }

    const since24h = now - 24 * 60 * 60_000;
    const actionEvents = history.actions.filter((a) => a.action === 'enqueue' && a.createdAt >= since24h);
    if (actionEvents.length >= dailyActionBudget()) {
      await auditAutohealEvent(clientId, { action: 'skip', reason: 'daily_budget_exceeded', budget: dailyActionBudget() });
      return { queued: false as const, reason: 'daily_budget_exceeded' };
    }
    const deepRepairCount = actionEvents.filter((a) => a.requestType === 'deep_repair').length;
    if (action === 'deep_repair' && deepRepairCount >= deepRepairBudget()) {
      await auditAutohealEvent(clientId, {
        action: 'skip',
        reason: 'deep_repair_budget_exceeded',
        budget: deepRepairBudget(),
      });
      return { queued: false as const, reason: 'deep_repair_budget_exceeded' };
    }

    const sameFpRecent = history.actions.find(
      (a) =>
        a.action === 'enqueue' &&
        a.fingerprint &&
        a.fingerprint === signal.fingerprint &&
        now - Number(a.createdAt ?? 0) < sameFingerprintCooldownMs(),
    );
    if (sameFpRecent) {
      await auditAutohealEvent(clientId, {
        action: 'skip',
        reason: 'same_fingerprint_cooldown',
        fingerprint: signal.fingerprint,
        previousActionAt: sameFpRecent.createdAt,
      });
      return { queued: false as const, reason: 'same_fingerprint_cooldown' };
    }

    const requestId = randomUUID();
    const payload = {
      autoheal: {
        fingerprint: signal.fingerprint,
        signalLevel: signal.level,
        driftCount: signal.driftCount,
        warningCount: signal.warningCount,
        driftRatio: signal.driftRatio,
        warningRatio: signal.warningRatio,
        lagAbs: signal.lagAbs,
        lagRatio: signal.lagRatio,
        requestedAt: now,
        serverSeq: reportAll.server?.serverSeq ?? null,
      },
    };
    await setClientSyncRequest(clientId, {
      id: requestId,
      type: action,
      at: now,
      payload: JSON.stringify(payload),
    });
    await auditAutohealEvent(clientId, {
      action: 'enqueue',
      requestId,
      requestType: action,
      fingerprint: signal.fingerprint,
      level: signal.level,
      payload,
    });
    logInfo('autoheal sync request enqueued', { clientId, requestId, requestType: action });
    return { queued: true as const, requestId, requestType: action };
  } catch (e) {
    logError('autoheal evaluation failed', { clientId, error: String(e) });
    return { queued: false as const, reason: 'error', error: String(e) };
  }
}

