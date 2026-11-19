import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ENGINE_KIND_REQUIRED_MESSAGE } from '@matricarmz/shared';

import { saveEngineCardGated } from './engineCardWrite.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Гейт вида при заведении двигателя (промты КАРМАНА #36 + #37).
 *
 * Требование владельца: новый двигатель нельзя сохранить без вида — если договор уже
 * выбран, вид берётся из него; если договора нет, оператор обязан поставить вид руками.
 *
 * Гейт живёт в единственной двери записи карточки (`saveEngineCardGated`), потому что у
 * карточки два входа: сама карточка и пачечный приём. Проверка в форме обошлась бы
 * пачкой (класс brain G363).
 */
function makeDb() {
  const sqlite = new Database(':memory:');
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
    CREATE TABLE operations (id text PRIMARY KEY NOT NULL, engine_entity_id text NOT NULL,
      operation_type text NOT NULL, status text NOT NULL, note text, performed_at integer, performed_by text,
      meta_json text, created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');

    INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES
      ('t-engine', 'engine', 'Engine', 1, 1),
      ('t-contract', 'contract', 'Contract', 1, 1);

    INSERT INTO entities (id, type_id, created_at, updated_at) VALUES
      ('contract-civil', 't-contract', 2, 2);

    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at) VALUES
      ('d-contract-sections', 't-contract', 'contract_sections', 'Разделы', 'json', 1, 1);

    INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES
      ('v-sections-1', 'contract-civil', 'd-contract-sections',
        '{"primary":{"number":"Д-1","kind":"civil"}}', 2, 2);
  `);
  return sqlite;
}

function deps(sqlite: Database.Database) {
  return { db: drizzle(sqlite), actor: 'tester', canWriteStageRow: false };
}

function cardRow(sqlite: Database.Database, id: string): Record<string, unknown> | undefined {
  return sqlite.prepare('SELECT * FROM erp_engine_cards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

function entityExists(sqlite: Database.Database, id: string): boolean {
  return Boolean(sqlite.prepare('SELECT id FROM entities WHERE id = ?').get(id));
}

describe('гейт вида при заведении двигателя', () => {
  it('новый двигатель без договора и без вида не сохраняется', async () => {
    const sqlite = makeDb();
    const res = await saveEngineCardGated(deps(sqlite), 'engine-1', { engine_number: 'А-1' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(ENGINE_KIND_REQUIRED_MESSAGE);
    // Отбитая запись не должна оставить сущность (deferred-create строго после гейтов).
    expect(entityExists(sqlite, 'engine-1')).toBe(false);
    expect(cardRow(sqlite, 'engine-1')).toBeUndefined();
  });

  it('новый двигатель с ручным видом сохраняется, вид ложится в карточку', async () => {
    const sqlite = makeDb();
    const res = await saveEngineCardGated(deps(sqlite), 'engine-2', {
      engine_number: 'А-2',
      engine_kind: 'military',
    });
    expect(res.ok).toBe(true);
    expect(cardRow(sqlite, 'engine-2')?.engine_kind).toBe('military');
  });

  it('новый двигатель с договором сохраняется: вид берётся из договора', async () => {
    const sqlite = makeDb();
    const res = await saveEngineCardGated(deps(sqlite), 'engine-3', {
      engine_number: 'А-3',
      contract_id: 'contract-civil',
    });
    expect(res.ok).toBe(true);
    // Ручной вид при этом не выдумывается: вид двигателя вычисляется (договор → карточка
    // → контрагент), в карточке лежит только ручное значение оператора.
    expect(cardRow(sqlite, 'engine-3')?.engine_kind ?? null).toBeNull();
    expect(cardRow(sqlite, 'engine-3')?.contract_id).toBe('contract-civil');
  });

  it('пустой ручной вид («вид снят») новый двигатель не проходит', async () => {
    const sqlite = makeDb();
    const res = await saveEngineCardGated(deps(sqlite), 'engine-4', {
      engine_number: 'А-4',
      engine_kind: '',
    });
    expect(res.ok).toBe(false);
    expect(entityExists(sqlite, 'engine-4')).toBe(false);
  });

  it('правка старой карточки без вида НЕ блокируется (обратная совместимость)', async () => {
    const sqlite = makeDb();
    // Карточка, заведённая до появления вида: сущность есть, вида нет.
    sqlite
      .prepare("INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('engine-old', 't-engine', 1, 1)")
      .run();
    const res = await saveEngineCardGated(deps(sqlite), 'engine-old', { engine_number: 'А-5' });
    expect(res.ok).toBe(true);
    expect(cardRow(sqlite, 'engine-old')?.engine_number).toBe('А-5');
  });

  it('договор без вида (секций нет) — вид по умолчанию, заведение проходит', async () => {
    const sqlite = makeDb();
    sqlite
      .prepare("INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('contract-plain', 't-contract', 2, 2)")
      .run();
    const res = await saveEngineCardGated(deps(sqlite), 'engine-6', {
      engine_number: 'А-6',
      contract_id: 'contract-plain',
    });
    expect(res.ok).toBe(true);
  });
});
