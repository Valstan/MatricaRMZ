import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export function migrateSqlite(db: BetterSQLite3Database, sqlite: Database.Database) {
  // drizzle migrator ожидает исходный sqlite handle
  migrate(db, { migrationsFolder: 'drizzle' });
  // VACUUM не запускаем автоматически — это дорого. Только при обслуживании.
  sqlite.pragma('optimize');
}


