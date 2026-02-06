import { net } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { hostname as getHostname } from 'node:os';

import { logMessageSetEnabled, logMessageSetMode } from './logService.js';
import {
  SettingsKey,
  settingsGetBoolean,
  settingsGetNumber,
  settingsGetString,
  settingsSetBoolean,
  settingsSetString,
} from './settingsStore.js';
import { resetSyncState, runSync } from './syncService.js';
import { httpAuthed } from './httpClient.js';
import { getEntityDetails } from './entityService.js';
import { attributeValues, entities, operations } from '../database/schema.js';

export type RemoteClientSettings = {
  updatesEnabled: boolean;
  torrentEnabled: boolean;
  loggingEnabled: boolean;
  loggingMode: 'dev' | 'prod';
};

type SyncProgressEvent = {
  mode: 'force_full_pull';
  state: 'start' | 'progress' | 'done' | 'error';
  startedAt: number;
  elapsedMs: number;
  estimateMs: number | null;
  etaMs: number | null;
  progress: number | null;
  pulled?: number;
  error?: string;
};

type RemoteSettingsResponse = {
  ok: boolean;
  settings?: {
    updatesEnabled?: boolean;
    torrentEnabled?: boolean;
    loggingEnabled?: boolean;
    loggingMode?: 'dev' | 'prod';
    syncRequestId?: string | null;
    syncRequestType?: 'sync_now' | 'force_full_pull' | null;
    syncRequestAt?: number | null;
    syncRequestPayload?: string | null;
  };
  error?: string;
};

function joinUrl(base: string, path: string) {
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  const p = String(path ?? '').trim().replace(/^\/+/, '');
  return `${b}/${p}`;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    return await net.fetch(url, { signal: ac.signal as any });
  } finally {
    clearTimeout(t);
  }
}

export async function getCachedClientSettings(db: BetterSQLite3Database): Promise<RemoteClientSettings> {
  const updatesEnabled = await settingsGetBoolean(db, SettingsKey.UpdatesEnabled, true);
  const torrentEnabled = await settingsGetBoolean(db, SettingsKey.TorrentEnabled, true);
  const loggingEnabled = await settingsGetBoolean(db, SettingsKey.LoggingEnabled, false);
  const rawMode = await settingsGetString(db, SettingsKey.LoggingMode);
  const loggingMode = rawMode === 'dev' ? 'dev' : 'prod';
  return { updatesEnabled, torrentEnabled, loggingEnabled, loggingMode };
}

export async function applyRemoteClientSettings(args: {
  db: BetterSQLite3Database;
  apiBaseUrl: string;
  clientId: string;
  version: string;
  log?: (msg: string) => void;
  onSyncProgress?: (event: SyncProgressEvent) => void;
}): Promise<RemoteClientSettings> {
  const { db, apiBaseUrl, clientId, version } = args;
  const hostname = getHostname();
  const platform = process.platform;
  const arch = process.arch;
  const url = joinUrl(
    apiBaseUrl,
    `/client/settings?clientId=${encodeURIComponent(clientId)}&version=${encodeURIComponent(version ?? '')}` +
      `&hostname=${encodeURIComponent(hostname)}&platform=${encodeURIComponent(platform)}&arch=${encodeURIComponent(arch)}`,
  );
  try {
    const res = await fetchWithTimeout(url, 8_000);
    const json = (await res.json().catch(() => null)) as RemoteSettingsResponse | null;
    if (!res.ok || !json?.ok || !json.settings) {
      args.log?.(`remote settings fetch failed: HTTP ${res.status}`);
      return await getCachedClientSettings(db);
    }
    const updatesEnabled = json.settings.updatesEnabled !== false;
    const torrentEnabled = json.settings.torrentEnabled !== false;
    const loggingEnabled = json.settings.loggingEnabled === true;
    const loggingMode = json.settings.loggingMode === 'dev' ? 'dev' : 'prod';

    await settingsSetBoolean(db, SettingsKey.UpdatesEnabled, updatesEnabled);
    await settingsSetBoolean(db, SettingsKey.TorrentEnabled, torrentEnabled);

    await logMessageSetEnabled(db, loggingEnabled, apiBaseUrl);
    await logMessageSetMode(db, loggingMode);

    const syncReqId = json.settings.syncRequestId ?? null;
    const syncReqType = json.settings.syncRequestType ?? null;
    const syncReqPayload = json.settings.syncRequestPayload ?? null;
    if (syncReqId && syncReqType) {
      const lastApplied = (await settingsGetString(db, SettingsKey.SyncRequestLastId).catch(() => null)) ?? '';
      if (lastApplied !== syncReqId) {
        await settingsSetString(db, SettingsKey.SyncRequestLastId, syncReqId);
        let payload: any = null;
        if (syncReqPayload) {
          try {
            payload = JSON.parse(String(syncReqPayload));
          } catch {
            payload = null;
          }
        }
        if (syncReqType === 'force_full_pull') {
          args.log?.(`sync request: force_full_pull id=${syncReqId}`);
          const startedAt = Date.now();
          const lastDuration = await settingsGetNumber(db, SettingsKey.LastFullPullDurationMs, 0);
          const estimateMs = Math.max(60_000, Math.min(15 * 60_000, lastDuration || 180_000));
          args.onSyncProgress?.({
            mode: 'force_full_pull',
            state: 'start',
            startedAt,
            elapsedMs: 0,
            estimateMs,
            etaMs: estimateMs,
            progress: 0,
          });
          await resetSyncState(db);
          await runSync(db, args.clientId, args.apiBaseUrl, {
            fullPull: { reason: 'force_full_pull', startedAt, estimateMs, onProgress: args.onSyncProgress },
          }).catch((e) => {
            args.log?.(`sync request failed: ${String(e)}`);
          });
          continue;
        } else if (syncReqType === 'sync_now') {
          args.log?.(`sync request: sync_now id=${syncReqId}`);
        } else if (syncReqType === 'entity_diff') {
          const entityId = payload?.entityId ? String(payload.entityId) : '';
          if (entityId) {
            args.log?.(`sync request: entity_diff id=${syncReqId} entityId=${entityId}`);
            try {
              const entity = await getEntityDetails(db, entityId);
              await httpAuthed(
                db,
                apiBaseUrl,
                '/diagnostics/entity-diff/report',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ clientId, entityId, entity }),
                },
                { timeoutMs: 20_000 },
              );
            } catch (e) {
              args.log?.(`entity_diff failed: ${String(e)}`);
            }
          }
        } else if (syncReqType === 'delete_local_entity') {
          const entityId = payload?.entityId ? String(payload.entityId) : '';
          if (entityId) {
            args.log?.(`sync request: delete_local_entity id=${syncReqId} entityId=${entityId}`);
            try {
              await db.delete(attributeValues).where(eq(attributeValues.entityId, entityId as any));
              await db.delete(operations).where(eq(operations.engineEntityId, entityId as any));
              await db.delete(entities).where(eq(entities.id, entityId as any));
            } catch (e) {
              args.log?.(`delete_local_entity failed: ${String(e)}`);
            }
          }
        }
        await runSync(db, args.clientId, args.apiBaseUrl).catch((e) => {
          args.log?.(`sync request failed: ${String(e)}`);
        });
      }
    }

    return { updatesEnabled, torrentEnabled, loggingEnabled, loggingMode };
  } catch (e) {
    args.log?.(`remote settings fetch error: ${String(e)}`);
    return await getCachedClientSettings(db);
  }
}

export function startClientSettingsPolling(args: {
  db: BetterSQLite3Database;
  apiBaseUrl: string;
  clientId: string;
  version: string;
  log?: (msg: string) => void;
  onApplied?: (settings: RemoteClientSettings) => void;
  onSyncProgress?: (event: SyncProgressEvent) => void;
}) {
  const intervalMs = 60_000;
  const tick = () =>
    void applyRemoteClientSettings(args)
      .then((settings) => args.onApplied?.(settings))
      .catch(() => {});
  tick();
  setInterval(tick, intervalMs);
}
