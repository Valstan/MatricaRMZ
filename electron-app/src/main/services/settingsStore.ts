import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { syncState } from '../database/schema.js';

export const SettingsKey = {
  // Network
  ApiBaseUrl: 'apiBaseUrl',

  // Sync cursors / diagnostics
  LastPulledServerSeq: 'lastPulledServerSeq',
  LastSyncAt: 'lastSyncAt',
  LastAppliedAt: 'lastAppliedAt',
  DiagnosticsLastSentAt: 'diagnostics.lastSentAt',
  DiagnosticsSchemaLastFetchedAt: 'diagnostics.schemaLastFetchedAt',
  DiagnosticsSchemaJson: 'diagnostics.schemaJson',

  // Client schema/migrations
  ClientSchemaVersion: 'schema.clientVersion',
  ServerSchemaHash: 'schema.serverHash',

  // Auth (encrypted JSON payload)
  AuthSession: 'auth.session',

  // Logging
  LoggingEnabled: 'logging.enabled',
  LoggingMode: 'logging.mode',

  // Files
  FilesDownloadDir: 'files.downloadDir',

  // Client identity (stable per workstation)
  ClientId: 'clientId',

  // UI preferences
  UiTheme: 'ui.theme',
  UiChatSide: 'ui.chatSide',
  UiTabsLayout: 'ui.tabs.layout',

  // Remote admin controls
  UpdatesEnabled: 'updates.enabled',
  TorrentEnabled: 'torrent.enabled',
} as const;

export type SettingsKey = (typeof SettingsKey)[keyof typeof SettingsKey];

function nowMs() {
  return Date.now();
}

function normalizeValue(v: string) {
  // We intentionally DO NOT coerce empty string to null:
  // some call-sites treat empty string as "cleared" value.
  return String(v);
}

export async function settingsGetString(db: BetterSQLite3Database, key: SettingsKey): Promise<string | null> {
  const row = await db.select().from(syncState).where(eq(syncState.key, key)).limit(1);
  const v = row[0]?.value;
  return typeof v === 'string' ? v : null;
}

export async function settingsSetString(db: BetterSQLite3Database, key: SettingsKey, value: string): Promise<void> {
  const ts = nowMs();
  await db
    .insert(syncState)
    .values({ key, value: normalizeValue(value), updatedAt: ts })
    .onConflictDoUpdate({ target: syncState.key, set: { value: normalizeValue(value), updatedAt: ts } });
}

export async function settingsGetNumber(db: BetterSQLite3Database, key: SettingsKey, fallback: number): Promise<number> {
  const raw = await settingsGetString(db, key);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function settingsSetNumber(db: BetterSQLite3Database, key: SettingsKey, value: number): Promise<void> {
  await settingsSetString(db, key, String(value));
}

export async function settingsGetBoolean(db: BetterSQLite3Database, key: SettingsKey, fallback: boolean): Promise<boolean> {
  const raw = await settingsGetString(db, key);
  if (raw == null || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

export async function settingsSetBoolean(db: BetterSQLite3Database, key: SettingsKey, value: boolean): Promise<void> {
  await settingsSetString(db, key, value ? 'true' : 'false');
}


