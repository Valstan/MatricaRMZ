// Тестовый адаптер AsyncSqlite поверх better-sqlite3 — только для vitest на
// десктопе (доказывает раннер/портированные сервисы без планшета). В бандл
// приложения не попадает: импортируется исключительно из *.test.ts.
import Database from 'better-sqlite3';

import type { AsyncSqlite, RunResult, SqlValue } from '../asyncSqlite.js';

export type BetterSqlite3AsyncAdapter = AsyncSqlite & { raw: Database.Database };

export function createBetterSqlite3AsyncAdapter(path = ':memory:'): BetterSqlite3AsyncAdapter {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return {
    raw: db,
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },
    async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes };
    },
    async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      if (!stmt.reader) {
        stmt.run(...params);
        return [];
      }
      return stmt.all(...params) as T[];
    },
    async get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
      const stmt = db.prepare(sql);
      if (!stmt.reader) {
        stmt.run(...params);
        return undefined;
      }
      return stmt.get(...params) as T | undefined;
    },
    async values(sql: string, params: SqlValue[] = []): Promise<SqlValue[][]> {
      const stmt = db.prepare(sql);
      if (!stmt.reader) {
        stmt.run(...params);
        return [];
      }
      return stmt.raw(true).all(...params) as SqlValue[][];
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}
