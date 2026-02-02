import { eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { clientSettings } from '../database/schema.js';

export type ClientSettingsRow = typeof clientSettings.$inferSelect;

type ClientSettingsPatch = Partial<Pick<ClientSettingsRow, 'updatesEnabled' | 'torrentEnabled' | 'loggingEnabled' | 'loggingMode'>>;
type ClientSyncRequest = { id: string; type: string; at: number; payload?: string | null };

function nowMs() {
  return Date.now();
}

function defaultSettings(): Omit<ClientSettingsRow, 'clientId' | 'createdAt' | 'updatedAt'> {
  return {
    updatesEnabled: true,
    torrentEnabled: true,
    loggingEnabled: false,
    loggingMode: 'prod',
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
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(clientSettings).values(row);
  return row;
}

export async function touchClientSettings(
  clientId: string,
  args: { version?: string | null; ip?: string | null; hostname?: string | null; platform?: string | null; arch?: string | null },
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
