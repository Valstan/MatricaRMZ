// Парити-гейт async-раннера: свежая БД, прокатанная нашим раннером
// (migrateSqliteAsync), обязана быть схемно идентичной свежей БД, прокатанной
// штатным путём Electron-клиента (migrateSqlite = drizzle-мигратор + parity +
// purge). Сравниваем sqlite_master и бухгалтерию __drizzle_migrations —
// расхождение цепочек ловится здесь, а не на планшете при холодном pull.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { migrateSqlite } from '../../../../electron-app/src/main/database/migrate.js';
import { entityTypes } from '../../../../electron-app/src/main/database/schema.js';
import { createBetterSqlite3AsyncAdapter } from '../testing/betterSqlite3Adapter.js';
import { createDrizzleAsync } from '../drizzleAsync.js';
import { migrateSqliteAsync } from '../migrate.js';
import { applyDrizzleChain } from './drizzleChain.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const migrationsFolder = resolve(here, '../../../../electron-app/drizzle');

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };

function schemaDump(db: Database.Database): Array<{ key: string; sql: string }> {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as MasterRow[];
  return rows.map((r) => ({
    key: `${r.type}:${r.name}`,
    sql: (r.sql ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

async function freshAsyncMigrated() {
  const adapter = createBetterSqlite3AsyncAdapter(':memory:');
  await migrateSqliteAsync(adapter);
  return adapter;
}

function freshElectronMigrated(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrateSqlite(drizzle(sqlite), sqlite, migrationsFolder);
  return sqlite;
}

describe('android drizzle chain runner', () => {
  it('схема свежей БД идентична штатному пути Electron-клиента', async () => {
    const android = await freshAsyncMigrated();
    const electron = freshElectronMigrated();
    expect(schemaDump(android.raw)).toEqual(schemaDump(electron));
    electron.close();
    await android.close();
  });

  it('бухгалтерия __drizzle_migrations совпадает со штатной (hash + created_at)', async () => {
    const android = await freshAsyncMigrated();
    const electron = freshElectronMigrated();
    const q = `SELECT hash, created_at FROM "__drizzle_migrations" ORDER BY created_at`;
    expect(await android.all(q)).toEqual(electron.prepare(q).all());
    electron.close();
    await android.close();
  });

  it('повторный прогон идемпотентен и применяет 0 миграций', async () => {
    const android = await freshAsyncMigrated();
    const second = await applyDrizzleChain(android);
    expect(second.applied).toEqual([]);
    await migrateSqliteAsync(android); // parity-шаг тоже обязан быть идемпотентным
    await android.close();
  });

  it('PRAGMA из 0007 реально исполняется: foreign_keys снова ON после цепочки', async () => {
    const android = await freshAsyncMigrated();
    const rows = await android.values('PRAGMA foreign_keys');
    expect(Number(rows[0]?.[0])).toBe(1);
    await android.close();
  });

  it('drizzle sqlite-proxy поверх фасада: run/all/get работают на мигрированной БД', async () => {
    const adapter = await freshAsyncMigrated();
    const db = createDrizzleAsync(adapter);
    await db.run(
      sql`INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('t-1', 'test_type', 'Тип', 1, 1)`,
    );
    // Сырой sql через proxy отдаёт позиционные строки…
    const rawRows = await db.all<[string]>(sql`SELECT code FROM entity_types WHERE id = 't-1'`);
    expect(rawRows).toEqual([['test_type']]);
    // …а объектный маппинг делает select-билдер по схеме (реальный путь сервисов).
    const selected = await db
      .select({ code: entityTypes.code, name: entityTypes.name })
      .from(entityTypes);
    expect(selected).toEqual([{ code: 'test_type', name: 'Тип' }]);
    // Промах raw-get через proxy — пустой массив (не undefined, как у better-sqlite3).
    const missing = await db.get(sql`SELECT name FROM entity_types WHERE id = 'nope'`);
    expect(missing).toEqual([]);
    await adapter.close();
  });
});
