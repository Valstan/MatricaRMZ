// Обвязка портированного syncService для android (Ф1.4): подставляет
// async-исполнитель, мигратор и reset-флоу через injection-точки syncService.
// Вызывается один раз на boot, до первого runSync.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  setEnsureClientSchemaCompatibleImpl,
  setResetLocalDatabaseImpl,
  setSyncSqlExecutor,
} from '../../../electron-app/src/main/services/syncService.js';
import type { SqlExecutor } from '../../../electron-app/src/main/database/sqlExecutor.js';

import type { AsyncSqlite, SqlValue } from '../db/asyncSqlite.js';
import type { AsyncDrizzleDb } from '../db/drizzleAsync.js';
import { ensureClientSchemaCompatible } from '../db/migrations/clientSchemaCompatible.js';
import { getAndroidPlatformHooks } from '../shims/platform.js';

export function createSqlExecutorFromAsyncSqlite(sqlite: AsyncSqlite): SqlExecutor {
  return {
    run: async (sql, params = []) => sqlite.run(sql, params as SqlValue[]),
    all: async (sql, params = []) => sqlite.all(sql, params as SqlValue[]),
    get: async (sql, params = []) => sqlite.get(sql, params as SqlValue[]),
    exec: async (sql) => sqlite.exec(sql),
    async transaction(fn) {
      await sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        await sqlite.exec('COMMIT');
        return result;
      } catch (e) {
        try {
          await sqlite.exec('ROLLBACK');
        } catch {
          // важно не заслонить исходную ошибку
        }
        throw e;
      }
    },
  };
}

export type AndroidSyncWiring = {
  sqlite: AsyncSqlite;
  db: AsyncDrizzleDb;
  /** Пересоздание локальной реплики на планшете (drop файла БД силами Capacitor-слоя). */
  resetLocalDatabaseFiles: () => Promise<void>;
};

export function wireSyncForAndroid(w: AndroidSyncWiring): void {
  setSyncSqlExecutor(createSqlExecutorFromAsyncSqlite(w.sqlite));
  // Сигнатура electron-мигратора — (db, schema, opts); android-порт дополнительно
  // получает низкоуровневый фасад для будущих цепочек 12→N.
  setEnsureClientSchemaCompatibleImpl(async (db, serverSchema, opts) =>
    ensureClientSchemaCompatible(db as unknown as AsyncDrizzleDb, w.sqlite, serverSchema, opts),
  );
  setResetLocalDatabaseImpl(async (_db: BetterSQLite3Database, reason: string) => {
    try {
      await w.resetLocalDatabaseFiles();
      getAndroidPlatformHooks().relaunch();
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: `android reset failed (${reason}): ${String(e)}` };
    }
  });
}
