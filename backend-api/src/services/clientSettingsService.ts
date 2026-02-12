import { eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { clientSettings } from '../database/schema.js';

export type ClientSettingsRow = typeof clientSettings.$inferSelect;

type ClientSettingsPatch = Partial<Pick<ClientSettingsRow, 'updatesEnabled' | 'torrentEnabled' | 'loggingEnabled' | 'loggingMode'>>;
type ClientSyncRequest = { id: string; type: string; at: number; payload?: string | null };
type ClientSyncAck = { requestId: string; status: 'ok' | 'error'; error?: string | null; at?: number };

function nowMs() {
  return Date.now();
}

function safeJsonParse(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function defaultSettings(): Omit<ClientSettingsRow, 'clientId' | 'createdAt' | 'updatedAt'> {
  return {
    updatesEnabled: true,
    torrentEnabled: true,
    loggingEnabled: true,
    loggingMode: 'dev',
    syncRequestId: null,
    syncRequestType: null,
    syncRequestAt: null,
    syncRequestPayload: null,
    lastSeenAt: null,
    lastVersion: null,
    lastIp: null,
    lastHostname: null,
    lastPlatform: null,
    lastArch: null,
    lastUsername: null,
  };
}

export async function getOrCreateClientSettings(clientId: string): Promise<ClientSettingsRow> {
  const rows = await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1);
  if (rows[0]) return rows[0];
  const ts = nowMs();
  const defaults = defaultSettings();
  const row: ClientSettingsRow = {
    clientId,
    updatesEnabled: defaults.updatesEnabled,
    torrentEnabled: defaults.torrentEnabled,
    loggingEnabled: defaults.loggingEnabled,
    loggingMode: defaults.loggingMode,
    syncRequestId: defaults.syncRequestId,
    syncRequestType: defaults.syncRequestType,
    syncRequestAt: defaults.syncRequestAt,
    syncRequestPayload: defaults.syncRequestPayload,
    lastSeenAt: null,
    lastVersion: null,
    lastIp: null,
    lastHostname: null,
    lastPlatform: null,
    lastArch: null,
    lastUsername: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(clientSettings).values(row);
  return row;
}

export async function touchClientSettings(
  clientId: string,
  args: {
    version?: string | null;
    ip?: string | null;
    hostname?: string | null;
    platform?: string | null;
    arch?: string | null;
    username?: string | null;
  },
): Promise<void> {
  const ts = nowMs();
  await db
    .update(clientSettings)
    .set({
      lastSeenAt: ts,
      lastVersion: args.version ?? null,
      lastIp: args.ip ?? null,
      lastHostname: args.hostname ?? null,
      lastPlatform: args.platform ?? null,
      lastArch: args.arch ?? null,
      lastUsername: args.username ?? null,
      updatedAt: ts,
    })
    .where(eq(clientSettings.clientId, clientId));
}

export async function listClientSettings(): Promise<ClientSettingsRow[]> {
  return await db.select().from(clientSettings);
}

export async function updateClientSettings(clientId: string, patch: ClientSettingsPatch): Promise<ClientSettingsRow> {
  await getOrCreateClientSettings(clientId);
  const ts = nowMs();
  await db
    .update(clientSettings)
    .set({
      ...(patch.updatesEnabled !== undefined ? { updatesEnabled: patch.updatesEnabled } : {}),
      ...(patch.torrentEnabled !== undefined ? { torrentEnabled: patch.torrentEnabled } : {}),
      ...(patch.loggingEnabled !== undefined ? { loggingEnabled: patch.loggingEnabled } : {}),
      ...(patch.loggingMode !== undefined ? { loggingMode: patch.loggingMode } : {}),
      updatedAt: ts,
    })
    .where(eq(clientSettings.clientId, clientId));
  const rows = await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1);
  return rows[0] ?? (await getOrCreateClientSettings(clientId));
}

export async function setClientSyncRequest(clientId: string, req: ClientSyncRequest): Promise<ClientSettingsRow> {
  await getOrCreateClientSettings(clientId);
  const ts = nowMs();
  await db
    .update(clientSettings)
    .set({
      syncRequestId: req.id,
      syncRequestType: req.type,
      syncRequestAt: req.at,
      syncRequestPayload: req.payload ?? null,
      updatedAt: ts,
    })
    .where(eq(clientSettings.clientId, clientId));
  const rows = await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1);
  return rows[0] ?? (await getOrCreateClientSettings(clientId));
}

export async function acknowledgeClientSyncRequest(clientId: string, ack: ClientSyncAck): Promise<ClientSettingsRow> {
  await getOrCreateClientSettings(clientId);
  const row = (await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1))[0] ?? null;
  if (!row) return await getOrCreateClientSettings(clientId);
  if (!row.syncRequestId || String(row.syncRequestId) !== String(ack.requestId)) return row;
  const ts = nowMs();
  const previousPayload = safeJsonParse(row.syncRequestPayload ?? null);
  const autohealPayload = previousPayload?.autoheal && typeof previousPayload.autoheal === 'object' ? previousPayload.autoheal : null;
  const payload = {
    ...(autohealPayload ? { autoheal: autohealPayload } : {}),
    ackAt: Number(ack.at ?? ts),
    ackStatus: ack.status,
    ...(ack.error ? { ackError: String(ack.error) } : {}),
    requestId: row.syncRequestId,
  };
  await db
    .update(clientSettings)
    .set({
      syncRequestId: null,
      syncRequestType: null,
      syncRequestAt: null,
      syncRequestPayload: JSON.stringify(payload),
      updatedAt: ts,
    })
    .where(eq(clientSettings.clientId, clientId));
  const next = await db.select().from(clientSettings).where(eq(clientSettings.clientId, clientId)).limit(1);
  return next[0] ?? (await getOrCreateClientSettings(clientId));
}
