import { net } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { hostname as getHostname } from 'node:os';

import { logMessageSetEnabled, logMessageSetMode } from './logService.js';
import { SettingsKey, settingsGetBoolean, settingsGetString, settingsSetBoolean } from './settingsStore.js';

export type RemoteClientSettings = {
  updatesEnabled: boolean;
  torrentEnabled: boolean;
  loggingEnabled: boolean;
  loggingMode: 'dev' | 'prod';
};

type RemoteSettingsResponse = {
  ok: boolean;
  settings?: {
    updatesEnabled?: boolean;
    torrentEnabled?: boolean;
    loggingEnabled?: boolean;
    loggingMode?: 'dev' | 'prod';
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
}) {
  const intervalMs = 5 * 60_000;
  setInterval(() => {
    void applyRemoteClientSettings(args)
      .then((settings) => args.onApplied?.(settings))
      .catch(() => {});
  }, intervalMs);
}
