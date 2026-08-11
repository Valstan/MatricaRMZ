// Обвязка портированного syncService для android (Ф1.4): подставляет
// async-исполнитель, мигратор и reset-флоу через injection-точки syncService.
// Вызывается один раз на boot, до первого runSync.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  setEnsureClientSchemaCompatibleImpl,
  setResetLocalDatabaseImpl,
  setSyncSqlExecutor,
} from '../../../electron-app/src/main/services/syncService.js';
import { setSyncSqlLimits } from '../../../electron-app/src/main/services/sync/upsertChunks.js';
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
  // Легаси-кап 999 bind-переменных системного SQLite + байтовый кап bridge-вызова:
  // Capacitor-мост парсит каждый вызов как один JSON в Java-куче (256 МБ), и
  // upsert прод-масштаба валит процесс OOM'ом до ответа SQLite (GOTCHAS M74).
  // 700 КБ по .length ≈ до ~1.5 МБ UTF-8 — с запасом от капа кучи.
  setSyncSqlLimits({ maxBindParams: 900, maxChunkBytes: 700_000 });
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
