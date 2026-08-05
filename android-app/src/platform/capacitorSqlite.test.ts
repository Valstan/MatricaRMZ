// Паритет-гейт платформенного адаптера: тот же набор обращений гоняется через
// стендовый better-sqlite3-адаптер (эталон) и через capacitor-адаптер поверх
// ФЕЙКОВОГО плагина, который повторяет неприятные свойства настоящего:
// строки — объекты (одноимённые колонки схлопываются) и NULL-ключи в JSON не
// приезжают вовсе. Расхождение результатов = регрессия порта.
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';

import { attributeValues, entities } from '../../../electron-app/src/main/database/schema.js';
import type { AsyncSqlite } from '../db/asyncSqlite.js';
import { createDrizzleAsync } from '../db/drizzleAsync.js';
import { createBetterSqlite3AsyncAdapter } from '../db/testing/betterSqlite3Adapter.js';
import { createCapacitorAsyncSqlite, type CapacitorDbConnection } from './capacitorSqlite.js';

const SCHEMA = `
  CREATE TABLE entities (
    id text PRIMARY KEY NOT NULL, type_id text NOT NULL, created_at integer NOT NULL,
    updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
    sync_status text NOT NULL DEFAULT 'synced'
  );
  CREATE TABLE attribute_values (
    id text PRIMARY KEY NOT NULL, entity_id text NOT NULL, attribute_def_id text NOT NULL,
    value_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
    last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced'
  );
`;

/** Плагин отдаёт строки объектами; NULL-колонки Android в JSON не кладёт. */
function createFakePluginConnection(db: Database.Database): CapacitorDbConnection {
  return {
    async execute(statements: string, transaction?: boolean) {
      if (transaction !== false) throw new Error('адаптер обязан звать execute с transaction:false');
      db.exec(statements);
      return {};
    },
    async run(statement: string, values: unknown[] = [], transaction?: boolean) {
      if (transaction !== false) throw new Error('адаптер обязан звать run с transaction:false');
      const info = db.prepare(statement).run(...(values as never[]));
      return { changes: { changes: info.changes } };
    },
    async query(statement: string, values: unknown[] = []) {
      const stmt = db.prepare(statement);
      if (!stmt.reader) {
        stmt.run(...(values as never[]));
        return { values: [] };
      }
      const rows = stmt.all(...(values as never[])) as Array<Record<string, unknown>>;
      return {
        values: rows.map((row) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v;
          return out;
        }),
      };
    },
    async close() {
      db.close();
    },
  };
}

type Stand = { reference: AsyncSqlite; ported: AsyncSqlite; dispose: () => void };

function createStand(): Stand {
  const reference = createBetterSqlite3AsyncAdapter(':memory:');
  const raw = new Database(':memory:');
  const ported = createCapacitorAsyncSqlite(createFakePluginConnection(raw));
  return {
    reference,
    ported,
    dispose: () => {
      reference.raw.close();
      if (raw.open) raw.close();
    },
  };
}

let stand: Stand | null = null;

afterEach(() => {
  stand?.dispose();
  stand = null;
});

async function onBoth(fn: (db: AsyncSqlite) => Promise<unknown>): Promise<[unknown, unknown]> {
  stand ??= createStand();
  return [await fn(stand.reference), await fn(stand.ported)];
}

async function seed(db: AsyncSqlite): Promise<void> {
  await db.exec(SCHEMA);
  await db.run(`INSERT INTO entities (id, type_id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?)`, [
    'e1',
    't1',
    1,
    2,
    null,
  ]);
  await db.run(
    `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?,?)`,
    ['v1', 'e1', 'd1', '"хвост"', 3, 4, 9],
  );
}

describe('capacitor-адаптер == стендовый better-sqlite3-адаптер', () => {
  it('run отдаёт число изменённых строк', async () => {
    const [a, b] = await onBoth(async (db) => {
      await seed(db);
      return db.run(`UPDATE entities SET updated_at = ? WHERE id = ?`, [99, 'e1']);
    });
    expect(b).toEqual(a);
    expect(a).toEqual({ changes: 1 });
  });

  it('all отдаёт строки объектами, включая NULL-колонки', async () => {
    const [a, b] = await onBoth(async (db) => {
      await seed(db);
      return db.all(`SELECT id, deleted_at FROM entities`);
    });
    expect(b).toEqual(a);
    expect(a).toEqual([{ id: 'e1', deleted_at: null }]);
  });

  it('get на пустой выборке даёт undefined', async () => {
    const [a, b] = await onBoth(async (db) => {
      await seed(db);
      return db.get(`SELECT id FROM entities WHERE id = ?`, ['нет']);
    });
    expect(b).toEqual(a);
    expect(a).toBeUndefined();
  });

  it('values отдаёт массивы в порядке колонок', async () => {
    const [a, b] = await onBoth(async (db) => {
      await seed(db);
      return db.values(`SELECT id, deleted_at, created_at FROM entities`);
    });
    expect(b).toEqual(a);
    expect(a).toEqual([['e1', null, 1]]);
  });

  it('values на джойне с одноимёнными колонками не теряет значений', async () => {
    const [a, b] = await onBoth(async (db) => {
      await seed(db);
      return db.values(
        `select "entities"."id", "entities"."deleted_at", "attribute_values"."id", "attribute_values"."deleted_at" ` +
          `from "entities" left join "attribute_values" on "attribute_values"."entity_id" = "entities"."id"`,
      );
    });
    expect(b).toEqual(a);
    expect(a).toEqual([['e1', null, 'v1', 9]]);
  });

  it('PRAGMA table_info читается одинаково', async () => {
    const [a, b] = await onBoth(async (db) => {
      await seed(db);
      const rows = await db.all<{ name: string }>(`PRAGMA table_info("entities")`);
      return rows.map((r) => r.name);
    });
    expect(b).toEqual(a);
    expect(a).toContain('sync_status');
  });

  it('exec пропускает многооператорный скрипт и PRAGMA вне транзакции', async () => {
    const [a, b] = await onBoth(async (db) => {
      await seed(db);
      await db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE tmp (x integer); PRAGMA foreign_keys=ON;`);
      await db.exec('BEGIN IMMEDIATE');
      await db.run(`INSERT INTO tmp (x) VALUES (?)`, [5]);
      await db.exec('COMMIT');
      return db.all(`SELECT x FROM tmp`);
    });
    expect(b).toEqual(a);
    expect(a).toEqual([{ x: 5 }]);
  });

  it('ROLLBACK откатывает начатую вручную транзакцию', async () => {
    const [a, b] = await onBoth(async (db) => {
      await seed(db);
      await db.exec('BEGIN IMMEDIATE');
      await db.run(`DELETE FROM entities`);
      await db.exec('ROLLBACK');
      return db.all(`SELECT id FROM entities`);
    });
    expect(b).toEqual(a);
    expect(a).toEqual([{ id: 'e1' }]);
  });
});

describe('drizzle поверх адаптера', () => {
  it('джойн через drizzle даёт те же строки, что и на стенде', async () => {
    const [a, b] = await onBoth(async (sqlite) => {
      await seed(sqlite);
      const db = createDrizzleAsync(sqlite);
      return db
        .select()
        .from(entities)
        .leftJoin(attributeValues, eq(attributeValues.entityId, entities.id));
    });
    expect(b).toEqual(a);
    expect(a).toEqual([
      {
        entities: {
          id: 'e1',
          typeId: 't1',
          createdAt: 1,
          updatedAt: 2,
          lastServerSeq: null,
          deletedAt: null,
          syncStatus: 'synced',
        },
        attribute_values: {
          id: 'v1',
          entityId: 'e1',
          attributeDefId: 'd1',
          valueJson: '"хвост"',
          createdAt: 3,
          updatedAt: 4,
          lastServerSeq: null,
          deletedAt: 9,
          syncStatus: 'synced',
        },
      },
    ]);
  });

  it('insert … returning через drizzle отдаёт вставленную строку', async () => {
    const [a, b] = await onBoth(async (sqlite) => {
      await seed(sqlite);
      const db = createDrizzleAsync(sqlite);
      return db
        .insert(entities)
        .values({ id: 'e2', typeId: 't1', createdAt: 5, updatedAt: 6, syncStatus: 'pending' })
        .returning({ id: entities.id, syncStatus: entities.syncStatus });
    });
    expect(b).toEqual(a);
    expect(a).toEqual([{ id: 'e2', syncStatus: 'pending' }]);
  });
});

describe('маршрутизация exec (Android-ограничение плагина)', () => {
  it('PRAGMA идёт через query, DDL/транзакции — через execute', async () => {
    const calls: Array<{ via: string; sql: string }> = [];
    const raw = new Database(':memory:');
    const conn: CapacitorDbConnection = {
      async execute(statements: string) {
        calls.push({ via: 'execute', sql: statements });
        raw.exec(statements);
        return {};
      },
      async run(statement: string, values: unknown[] = []) {
        const info = raw.prepare(statement).run(...(values as never[]));
        return { changes: { changes: info.changes } };
      },
      async query(statement: string) {
        calls.push({ via: 'query', sql: statement });
        const stmt = raw.prepare(statement);
        if (!stmt.reader) {
          stmt.run();
          return { values: [] };
        }
        const rows = stmt.all() as Array<Record<string, unknown>>;
        return { values: rows };
      },
      async close() {
        raw.close();
      },
    };
    const db = createCapacitorAsyncSqlite(conn);

    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('BEGIN IMMEDIATE');
    await db.exec('COMMIT');
    await db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE tmp (x integer); PRAGMA foreign_keys=ON;`);

    expect(calls).toEqual([
      { via: 'query', sql: 'PRAGMA journal_mode = WAL;' },
      { via: 'execute', sql: 'BEGIN IMMEDIATE' },
      { via: 'execute', sql: 'COMMIT' },
      // Multi-statement PRAGMA-скрипт query() не переварит — остаётся на execute()
      // (в проде таких нет, это только паритет с better-sqlite3-стендом).
      { via: 'execute', sql: `PRAGMA foreign_keys=OFF; CREATE TABLE tmp (x integer); PRAGMA foreign_keys=ON;` },
    ]);
  });
});
