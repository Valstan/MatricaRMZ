import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { findEngineByExactNumber, listEngineCharacteristicDefs } from './engineExactLookupService.js';

const here = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE entity_types (id text PRIMARY KEY NOT NULL, code text NOT NULL, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE entities (id text PRIMARY KEY NOT NULL, type_id text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_defs (id text PRIMARY KEY NOT NULL, entity_type_id text NOT NULL,
      code text NOT NULL, name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0, meta_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_values (id text PRIMARY KEY NOT NULL, entity_id text NOT NULL,
      attribute_def_id text NOT NULL, value_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  `);
  sqlite.exec(readFileSync(join(here, '../../../drizzle/0032_erp_engine_cards_replica.sql'), 'utf8'));
  sqlite.exec(readFileSync(join(here, '../../../drizzle/0037_engine_rmz_numbers_replica.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('t-engine', 'engine', 'Двигатель', 1, 1);
    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, sort_order, created_at, updated_at)
      VALUES ('d-number', 't-engine', 'engine_number', 'Номер двигателя', 'text', 10, 1, 1);
    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, sort_order, created_at, updated_at)
      VALUES ('d-internal', 't-engine', 'engine_internal_number', 'Внутренний номер', 'text', 15, 1, 1);
    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, sort_order, created_at, updated_at)
      VALUES ('d-year', 't-engine', 'engine_internal_number_year', 'Год внутреннего номера', 'number', 16, 1, 1);
  `);
  return { sqlite, db: drizzle(sqlite) };
}

function addEngine(
  sqlite: Database.Database,
  id: string,
  values: { engineNumber?: string; internalNumber?: string; internalNumberYear?: number },
): void {
  sqlite.exec(`INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('${id}', 't-engine', 1, 1)`);
  const put = (defId: string, value: unknown) =>
    sqlite
      .prepare(
        `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
         VALUES (?,?,?,?,1,1)`,
      )
      .run(`v-${id}-${defId}`, id, defId, JSON.stringify(value));
  if (values.engineNumber != null) put('d-number', values.engineNumber);
  if (values.internalNumber != null) put('d-internal', values.internalNumber);
  if (values.internalNumberYear != null) put('d-year', values.internalNumberYear);
}

describe('findEngineByExactNumber', () => {
  it('находит по документному номеру — точно, по канон-ключу', async () => {
    const { sqlite, db } = makeDb();
    addEngine(sqlite, 'e-1', { engineNumber: 'А-1' });
    const found = await findEngineByExactNumber(db, 'а 1');
    expect(found.engine?.id).toBe('e-1');
    expect(found.engine?.matchedBy).toBe('engine_number');
    expect(found.note).toBeNull();
    sqlite.close();
  });

  it('находит по внутреннему клейму «41/26»', async () => {
    const { sqlite, db } = makeDb();
    addEngine(sqlite, 'e-2', { engineNumber: 'Д-100', internalNumber: '41', internalNumberYear: 2026 });
    const found = await findEngineByExactNumber(db, '41/26');
    expect(found.engine?.id).toBe('e-2');
    expect(found.engine?.matchedBy).toBe('internal_number');
    expect(found.engine?.internalNumberFull).toBe('41/26');
    sqlite.close();
  });

  it('номер без года у нескольких двигателей — не «нашли», а объяснение', async () => {
    const { sqlite, db } = makeDb();
    addEngine(sqlite, 'e-3', { engineNumber: 'Д-101', internalNumber: '41', internalNumberYear: 2025 });
    addEngine(sqlite, 'e-4', { engineNumber: 'Д-102', internalNumber: '41', internalNumberYear: 2026 });
    const found = await findEngineByExactNumber(db, '41');
    expect(found.engine).toBeNull();
    expect(found.note).toContain('уточните номер с годом');
    sqlite.close();
  });

  it('в базе нет — пусто без выдуманного «похожего»', async () => {
    const { sqlite, db } = makeDb();
    addEngine(sqlite, 'e-5', { engineNumber: 'А-5' });
    const found = await findEngineByExactNumber(db, '77/26');
    expect(found.engine).toBeNull();
    expect(found.note).toBeNull();
    sqlite.close();
  });
});

describe('listEngineCharacteristicDefs', () => {
  it('отдаёт дефы двигателя с подписями', async () => {
    const { sqlite, db } = makeDb();
    const defs = await listEngineCharacteristicDefs(db);
    expect(defs.map((d) => d.code)).toEqual(['engine_number', 'engine_internal_number', 'engine_internal_number_year']);
    expect(defs[0]?.name).toBe('Номер двигателя');
    sqlite.close();
  });
});
