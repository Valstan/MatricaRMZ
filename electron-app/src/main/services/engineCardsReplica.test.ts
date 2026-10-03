import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { readEngineCardStrict, saveEngineCardStrict } from './engineCardsReplica.js';

const here = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const sqlite = new Database(':memory:');
  const sql = readFileSync(join(here, '../../../drizzle/0032_erp_engine_cards_replica.sql'), 'utf8');
  sqlite.exec(sql);
  return { sqlite, db: drizzle(sqlite) };
}

describe('engineCardsReplica (E3b)', () => {
  it('первая запись — insert pending', async () => {
    const { sqlite, db } = makeDb();
    const r = await saveEngineCardStrict(db as never, 'e-1', { engine_number: 'A-1', engine_note: 'n' }, 1000);
    expect(r.changed).toBe(true);
    const row = sqlite.prepare(`SELECT engine_number AS n, engine_note AS m, sync_status AS s FROM erp_engine_cards WHERE id='e-1'`).get() as any;
    expect(row).toMatchObject({ n: 'A-1', m: 'n', s: 'pending' });
    sqlite.close();
  });

  it('повтор тех же значений — changed:false', async () => {
    const { sqlite, db } = makeDb();
    await saveEngineCardStrict(db as never, 'e-1', { engine_number: 'A-1' }, 1000);
    const r = await saveEngineCardStrict(db as never, 'e-1', { engine_number: 'A-1' }, 2000);
    expect(r.changed).toBe(false);
    sqlite.close();
  });

  it('изменение — update pending, created_at не трогает', async () => {
    const { sqlite, db } = makeDb();
    await saveEngineCardStrict(db as never, 'e-1', { engine_number: 'A-1' }, 1000);
    const r = await saveEngineCardStrict(db as never, 'e-1', { engine_number: 'A-2', status_repaired: true }, 2000);
    expect(r.changed).toBe(true);
    const row = sqlite.prepare(`SELECT engine_number AS n, created_at AS c, updated_at AS u, sync_status AS s FROM erp_engine_cards WHERE id='e-1'`).get() as any;
    expect(row.n).toBe('A-2');
    expect(row.c).toBe(1000);
    expect(row.u).toBe(2000);
    expect(row.s).toBe('pending');
    const back = await readEngineCardStrict(db as never, 'e-1');
    expect(back?.statusRepaired).toBe(true);
    sqlite.close();
  });

  it('неизвестные коды игнорируются, пустой патч — changed:false', async () => {
    const { sqlite, db } = makeDb();
    const r = await saveEngineCardStrict(db as never, 'e-1', { hacker: 1 }, 1000);
    expect(r.changed).toBe(false);
    sqlite.close();
  });

  it('без реплики подложка берётся из EAV (не null-затирание канона)', async () => {
    const { sqlite, db } = makeDb();
    sqlite.exec(`
      CREATE TABLE entity_types (id text PRIMARY KEY NOT NULL, code text NOT NULL, name text NOT NULL,
        created_at integer NOT NULL, updated_at integer NOT NULL);
      CREATE TABLE entities (id text PRIMARY KEY NOT NULL, type_id text NOT NULL,
        created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer);
      CREATE TABLE attribute_defs (id text PRIMARY KEY NOT NULL, entity_type_id text NOT NULL, code text NOT NULL,
        name text NOT NULL, data_type text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer);
      CREATE TABLE attribute_values (id text PRIMARY KEY NOT NULL, entity_id text NOT NULL, attribute_def_id text NOT NULL,
        value_json text, created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer);
      INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('t-e', 'engine', 'E', 1, 1);
      INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('e-9', 't-e', 1, 1);
      INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at)
        VALUES ('d-1', 't-e', 'engine_number', 'N', 'text', 1, 1);
      INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
        VALUES ('v-1', 'e-9', 'd-1', '"EAV-9"', 1, 1);
    `);
    const r = await saveEngineCardStrict(db as never, 'e-9', { engine_note: 'n' }, 1000);
    expect(r.changed).toBe(true);
    const row = sqlite.prepare(`SELECT engine_number AS n, engine_note AS m, sync_status AS s FROM erp_engine_cards WHERE id='e-9'`).get() as any;
    expect(row).toMatchObject({ n: 'EAV-9', m: 'n', s: 'pending' });
    sqlite.close();
  });
});
