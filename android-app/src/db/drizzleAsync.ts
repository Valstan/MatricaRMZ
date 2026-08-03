// Drizzle поверх async-шва: sqlite-proxy вызывает наш AsyncSqlite вместо
// better-sqlite3. Схема (electron-app/src/main/database/schema.ts) — чистый
// sqlite-core и работает с любым драйвером.
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';

import type { AsyncSqlite, SqlValue } from './asyncSqlite.js';

export type AsyncDrizzleDb = SqliteRemoteDatabase<Record<string, never>>;

export function createDrizzleAsync(sqlite: AsyncSqlite): AsyncDrizzleDb {
  return drizzle(async (sql, params, method) => {
    const bound = (params ?? []) as SqlValue[];
    if (method === 'run') {
      await sqlite.run(sql, bound);
      return { rows: [] };
    }
    if (method === 'get') {
      const rows = await sqlite.values(sql, bound);
      return { rows: rows[0] ?? [] };
    }
    // 'all' и 'values' — строки массивами в порядке колонок.
    return { rows: await sqlite.values(sql, bound) };
  });
}
