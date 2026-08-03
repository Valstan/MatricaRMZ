// Boot-модуль android-ядра (Ф1.7): единая последовательность холодного старта —
// миграции → drizzle → обвязка syncService → clientId → SyncManager → heartbeat.
// Платформенный слой (Capacitor) даёт только открытую БД, reset-функцию и хуки
// (setAndroidPlatformHooks) — всё остальное здесь, и это же гоняется vitest'ом
// на десктопе через better-sqlite3-адаптер.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { SyncManager } from '../../../electron-app/src/main/services/syncManager.js';
import { startClientSettingsPolling } from '../../../electron-app/src/main/services/clientAdminService.js';
import {
  SettingsKey,
  settingsGetString,
  settingsSetString,
} from '../../../electron-app/src/main/services/settingsStore.js';

import type { AsyncSqlite } from '../db/asyncSqlite.js';
import { createDrizzleAsync, type AsyncDrizzleDb } from '../db/drizzleAsync.js';
import { migrateSqliteAsync } from '../db/migrate.js';
import { getAndroidPlatformHooks } from '../shims/platform.js';
import { ensureClientId } from './clientId.js';
import { wireSyncForAndroid } from './syncWiring.js';

export type AndroidCoreConfig = {
  sqlite: AsyncSqlite;
  /** Дефолтный API base URL первой установки; после — правится настройкой в БД. */
  defaultApiBaseUrl: string;
  resetLocalDatabaseFiles: () => Promise<void>;
  onSyncProgress?: Parameters<typeof startClientSettingsPolling>[0]['onSyncProgress'];
  log?: (msg: string) => void;
};

export type AndroidCore = {
  sqlite: AsyncSqlite;
  db: AsyncDrizzleDb;
  /** Тот же db, приведённый к типу портированных сервисов. */
  serviceDb: BetterSQLite3Database;
  clientId: string;
  apiBaseUrl: string;
  syncManager: SyncManager;
  /** Heartbeat /client/settings раз в минуту (внутри — и админ-команды синка). */
  startHeartbeat: () => void;
};

export async function bootAndroidCore(cfg: AndroidCoreConfig): Promise<AndroidCore> {
  await migrateSqliteAsync(cfg.sqlite);
  const db = createDrizzleAsync(cfg.sqlite);
  const serviceDb = db as unknown as BetterSQLite3Database;

  wireSyncForAndroid({ sqlite: cfg.sqlite, db, resetLocalDatabaseFiles: cfg.resetLocalDatabaseFiles });

  const stored = String((await settingsGetString(serviceDb, SettingsKey.ApiBaseUrl).catch(() => null)) ?? '').trim();
  const apiBaseUrl = stored || cfg.defaultApiBaseUrl;
  if (!stored) await settingsSetString(serviceDb, SettingsKey.ApiBaseUrl, apiBaseUrl);

  const clientId = await ensureClientId(serviceDb);

  const syncManager = new SyncManager(serviceDb, clientId, apiBaseUrl);

  const startHeartbeat = () =>
    startClientSettingsPolling({
      db: serviceDb,
      apiBaseUrl,
      clientId,
      version: getAndroidPlatformHooks().appVersion(),
      ...(cfg.log ? { log: cfg.log } : {}),
      ...(cfg.onSyncProgress ? { onSyncProgress: cfg.onSyncProgress } : {}),
    });

  return { sqlite: cfg.sqlite, db, serviceDb, clientId, apiBaseUrl, syncManager, startHeartbeat };
}
