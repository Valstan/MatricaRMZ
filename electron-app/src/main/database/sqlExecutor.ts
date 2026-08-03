// Async-шов над сырым SQLite для кода, который обязан работать и на десктопе
// (better-sqlite3, sync), и в android-порте (Capacitor-адаптер, async) —
// прежде всего syncService (план android-tablet-client-2026-08, Ф1.4).
//
// Десктоп-реализация оборачивает sync-вызовы в resolved-промисы — поведение
// не меняется. transaction() у обеих реализаций — BEGIN IMMEDIATE..COMMIT/ROLLBACK
// statement'ами (native sqlite.transaction() не умеет async-колбэк): внутри
// main-процесса все обращения к БД идут из одного event loop, поэтому чужие
// запросы между await'ами теоретически попадают в открытую транзакцию — для
// коротких remap/align-транзакций синка это принятый компромисс (при ошибке
// транзакция и раньше валила весь sync-проход).

import type BetterSqlite3 from 'better-sqlite3';

export type SqlRunResult = { changes: number };

export interface SqlExecutor {
  run(sql: string, params?: unknown[]): Promise<SqlRunResult>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export function createBetterSqlite3Executor(sqlite: BetterSqlite3.Database): SqlExecutor {
  const executor: SqlExecutor = {
    async run(sql, params = []) {
      const info = sqlite.prepare(sql).run(...(params as never[]));
      return { changes: Number(info.changes ?? 0) };
    },
    async all(sql, params = []) {
      return sqlite.prepare(sql).all(...(params as never[])) as never;
    },
    async get(sql, params = []) {
      return sqlite.prepare(sql).get(...(params as never[])) as never;
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
    async transaction(fn) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        sqlite.exec('COMMIT');
        return result;
      } catch (e) {
        try {
          sqlite.exec('ROLLBACK');
        } catch {
          // соединение могло уже закрыться — важно не заслонить исходную ошибку
        }
        throw e;
      }
    },
  };
  return executor;
}
