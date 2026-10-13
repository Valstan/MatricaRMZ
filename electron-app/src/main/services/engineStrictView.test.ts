import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const here = dirname(fileURLToPath(import.meta.url));

function src(rel: string): string {
  return readFileSync(join(here, rel), 'utf8').replace(/\r\n/g, '\n');
}

// A3: оба читателя обязаны merge'ить строгую реплику — иначе свеженаписанное
// видно только после синк-круга, а новая карточка выглядит пустой.
describe('читатели двигателей видят строгую реплику сразу (A3)', () => {
  it('getEngineDetails merge’ит реплику поверх EAV', () => {
    const text = src('./engineService.ts');
    expect(text).toContain('mergeStrictCardAttrs');
    expect(text).toContain('readEngineCardStrict');
  });

  it('listEngines тянет реплику батчем и подменяет identity-блок', () => {
    const text = src('./engineService.ts');
    expect(text).toContain('strictByEngineId');
    expect(text).toContain('erpEngineCards');
  });
});

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE entity_types (id text PRIMARY KEY NOT NULL, code text NOT NULL, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE entities (id text PRIMARY KEY NOT NULL, type_id text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_defs (id text PRIMARY KEY NOT NULL, entity_type_id text NOT NULL, code text NOT NULL,
      name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0, sort_order integer NOT NULL DEFAULT 0,
      meta_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_values (id text PRIMARY KEY NOT NULL, entity_id text NOT NULL, attribute_def_id text NOT NULL,
      value_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('t-engine', 'engine', 'Engine', 1, 1);
    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at)
      VALUES ('d-num', 't-engine', 'engine_number', 'N', 'text', 1, 1),
             ('d-brand', 't-engine', 'engine_brand', 'B', 'text', 1, 1);
  `);
  const strictSql = readFileSync(join(here, '../../../drizzle/0032_erp_engine_cards_replica.sql'), 'utf8');
  sqlite.exec(strictSql);
  return { sqlite, db: drizzle(sqlite) };
}

// A3: запись карточки идёт только в строгую реплику (E3b), а чтение — из EAV.
// Слияние (посвежее побеждает) обязано показывать свеженаписанное сразу,
// не дожидаясь возвращения серверного EAV-следа pull'ом.
describe('mergeStrictCardAttrs (A3)', () => {
  it('новый двигатель: EAV пуст — всё из реплики', async () => {
    const { mergeStrictCardAttrs } = await import('./engineCardsReplica.js');
    const out = mergeStrictCardAttrs(
      {},
      {
        engineNumber: 'Д-101',
        engineBrand: 'ЯМЗ',
        engineInternalNumberYear: 2026,
        updatedAt: 1000,
        deletedAt: null,
      } as never,
      1000,
    );
    expect(out.engine_number).toBe('Д-101');
    expect(out.engine_brand).toBe('ЯМЗ');
    expect(out.engine_internal_number_year).toBe(2026);
  });

  it('посвежее побеждает в обе стороны', async () => {
    const { mergeStrictCardAttrs } = await import('./engineCardsReplica.js');
    const strict = { engineNumber: 'СТРОГО', updatedAt: 2000, deletedAt: null } as never;
    // EAV свежее — остаётся EAV.
    expect(
      mergeStrictCardAttrs({ engine_number: { value: 'ЭАВ', updatedAt: 3000 } }, strict, 2000).engine_number,
    ).toBe('ЭАВ');
    // Реплика свежее — берётся реплика.
    expect(
      mergeStrictCardAttrs({ engine_number: { value: 'ЭАВ', updatedAt: 1000 } }, strict, 2000).engine_number,
    ).toBe('СТРОГО');
  });

  it('снятая реплика игнорируется', async () => {
    const { mergeStrictCardAttrs } = await import('./engineCardsReplica.js');
    const out = mergeStrictCardAttrs(
      { engine_number: { value: 'ЭАВ', updatedAt: 1000 } },
      { engineNumber: 'СТРОГО', updatedAt: 2000, deletedAt: 5 } as never,
      2000,
    );
    expect(out.engine_number).toBe('ЭАВ');
  });
});

describe('getEngineDetails после первого сейва новой карточки (A3)', () => {
  it('первый сейв виден сразу, без синк-круга', async () => {
    const { sqlite, db } = makeDb();
    const { ensureEngineRow, getEngineDetails } = await import('./engineService.js');
    const { saveEngineCardStrict } = await import('./engineCardsReplica.js');
    const id = 'e-new-1';
    await ensureEngineRow(db as never, id, 1000, 'tester');
    await saveEngineCardStrict(
      db as never,
      id,
      { engine_number: 'Д-101', engine_brand: 'ЯМЗ', arrival_date: 1728000000000 },
      1000,
    );
    const details = await getEngineDetails(db as never, id);
    expect(details.attributes['engine_number']).toBe('Д-101');
    expect(details.attributes['engine_brand']).toBe('ЯМЗ');
    expect(details.attributes['arrival_date']).toBe(1728000000000);
    sqlite.close();
  });
});
