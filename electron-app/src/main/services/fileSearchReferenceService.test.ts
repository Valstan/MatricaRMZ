import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { resolveReferenceLabels } from './fileSearchReferenceService.js';

const here = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(here, '../../../drizzle/0027_erp_counterparties_replica.sql'), 'utf8'));
  sqlite.exec(readFileSync(join(here, '../../../drizzle/0028_erp_contracts_replica.sql'), 'utf8'));
  sqlite.exec(readFileSync(join(here, '../../../drizzle/0032_erp_engine_cards_replica.sql'), 'utf8'));
  sqlite.exec(`
    CREATE TABLE entity_types (id text PRIMARY KEY NOT NULL, code text NOT NULL, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE entities (id text PRIMARY KEY NOT NULL, type_id text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_defs (id text PRIMARY KEY NOT NULL, entity_type_id text NOT NULL, code text NOT NULL,
      name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0, sort_order integer NOT NULL DEFAULT 0,
      meta_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_values (id text PRIMARY KEY NOT NULL, entity_id text NOT NULL, attribute_def_id text NOT NULL,
      value_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  `);
  return drizzle(sqlite);
}

describe('расшифровка ссылок карточки', () => {
  it('контракт, заказчик и двигатель отдаются именами, а не id', async () => {
    const db = makeDb();
    db.run(`INSERT INTO erp_contracts (id, number, created_at, updated_at) VALUES ('k1', '303', 1, 1)`);
    db.run(`INSERT INTO erp_counterparties (id, name, created_at, updated_at) VALUES ('c1', 'АО "РТ Гранит"', 1, 1)`);
    db.run(
      `INSERT INTO erp_engine_cards (id, engine_number, created_at, updated_at) VALUES ('e1', 'Э06АТ0889', 1, 1)`,
    );
    const labels = await resolveReferenceLabels(db, ['k1', 'c1', 'e1']);
    expect(labels).toEqual({ k1: '303', c1: 'АО "РТ Гранит"', e1: 'Э06АТ0889' });
  });

  it('справочник без строгой таблицы берётся по названию из EAV', async () => {
    const db = makeDb();
    db.run(`INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('t-brand', 'engine_brand', 'Марка', 1, 1)`);
    db.run(`INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('brand-1', 't-brand', 1, 1)`);
    db.run(
      `INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at) VALUES ('d-name', 't-brand', 'name', 'Марка', 'text', 1, 1)`,
    );
    db.run(
      `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES ('v1', 'brand-1', 'd-name', '"В-46-2С1"', 1, 1)`,
    );
    const labels = await resolveReferenceLabels(db, ['brand-1']);
    expect(labels['brand-1']).toBe('В-46-2С1');
  });

  it('неизвестная ссылка остаётся без названия — лучше пусто, чем выдуманное имя', async () => {
    const db = makeDb();
    const labels = await resolveReferenceLabels(db, ['нет-такого']);
    expect(labels['нет-такого']).toBeUndefined();
  });

  it('пустой список не ходит в базу', async () => {
    const db = makeDb();
    expect(await resolveReferenceLabels(db, [])).toEqual({});
  });
});
