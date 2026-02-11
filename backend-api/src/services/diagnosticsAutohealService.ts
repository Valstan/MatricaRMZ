import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { clientSettings, diagnosticsSnapshots } from '../database/schema.js';
import { getConsistencyReport, type ConsistencyClientReport } from './diagnosticsConsistencyService.js';
import { setClientSyncRequest } from './clientSettingsService.js';
import { logError, logInfo } from '../utils/logger.js';

type AutohealAction = 'force_full_pull_v2' | 'reset_sync_state_and_pull' | 'deep_repair';

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

function driftThreshold() {
  const raw = Number(process.env.MATRICA_SYNC_DRIFT_THRESHOLD ?? 2);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

function chooseAction(report: ConsistencyClientReport, serverSeq: number | null): AutohealAction | null {
  if (report.status !== 'drift' && report.status !== 'warning') return null;
  const driftCount = report.diffs.filter((d) => d.status === 'drift').length;
  const warningCount = report.diffs.filter((d) => d.status === 'warning').length;
  const lag = Math.max(0, Number(serverSeq ?? 0) - Number(report.lastPulledServerSeq ?? 0));
  if (driftCount >= Math.max(1, driftThreshold()) || lag > 50_000) return 'deep_repair';
  if (driftCount > 0 || warningCount >= Math.max(2, driftThreshold())) return 'reset_sync_state_and_pull';
  return 'force_full_pull_v2';
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

async function auditAutohealEvent(clientId: string, payload: Record<string, unknown>) {
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
    logError('autoheal audit insert failed', { clientId, error: String(e) });
  }
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
    const action = chooseAction(report, reportAll.server?.serverSeq ?? null);
    if (!action) return { queued: false as const, reason: 'status_ok' };

    const row = (await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1))[0] ?? null;
    const cooldown = autohealCooldownMs();
    const now = nowMs();
    if (row?.syncRequestAt && now - Number(row.syncRequestAt) < cooldown) {
      await auditAutohealEvent(clientId, { action: 'skip', reason: 'cooldown', syncRequestAt: Number(row.syncRequestAt) });
      return { queued: false as const, reason: 'cooldown' };
    }
    const fingerprint = buildFingerprint(report);
    const previousPayload = parseJson(row?.syncRequestPayload ?? null);
    if (row?.syncRequestType && previousPayload?.autoheal?.fingerprint === fingerprint) {
      await auditAutohealEvent(clientId, { action: 'skip', reason: 'same_fingerprint', fingerprint });
      return { queued: false as const, reason: 'same_fingerprint' };
    }

    const requestId = randomUUID();
    const payload = {
      autoheal: {
        fingerprint,
        status: report.status,
        driftCount: report.diffs.filter((d) => d.status === 'drift').length,
        warningCount: report.diffs.filter((d) => d.status === 'warning').length,
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
    await auditAutohealEvent(clientId, { action: 'enqueue', requestId, requestType: action, payload });
    logInfo('autoheal sync request enqueued', { clientId, requestId, requestType: action });
    return { queued: true as const, requestId, requestType: action };
  } catch (e) {
    logError('autoheal evaluation failed', { clientId, error: String(e) });
    return { queued: false as const, reason: 'error', error: String(e) };
  }
}

