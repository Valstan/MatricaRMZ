import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

let lastWritableSqlite: Database.Database | null = null;

export function openSqlite(dbPath: string) {
  const sqlite = new Database(dbPath);
  lastWritableSqlite = sqlite;
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  return { sqlite, db };
}

export function openSqliteReadonly(dbPath: string) {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  sqlite.pragma('query_only = ON');
  sqlite.pragma('foreign_keys = OFF');
  const db = drizzle(sqlite);
  return { sqlite, db };
}

export function getSqliteHandle() {
  return lastWritableSqlite;
}


