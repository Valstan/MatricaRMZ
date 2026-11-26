import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { suggestEnginesByNumberFragment } from './engineNumberSuggestionService.js';

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

/** Двигатель в легаси-EAV. */
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

/** Двигатель в строгой реплике карточек (новые карточки пишутся туда). */
function addStrictEngine(sqlite: Database.Database, id: string, engineNumber: string): void {
  sqlite.exec(`INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('${id}', 't-engine', 1, 1)`);
  sqlite
    .prepare(
      `INSERT INTO erp_engine_cards (id, engine_number, created_at, updated_at) VALUES (?,?,1,1)`,
    )
    .run(id, engineNumber);
}

describe('подсказки по неполному номеру двигателя', () => {
  it('по последним цифрам находит полный номер', async () => {
    const { sqlite, db } = makeDb();
    addEngine(sqlite, 'e-1', { engineNumber: 'Э06АТ0889' });

    const suggestions = await suggestEnginesByNumberFragment(db, { q: '0889' });
    expect(suggestions.map((s) => s.engineNumber)).toEqual(['Э06АТ0889']);
    expect(suggestions[0]?.id).toBe('e-1');
    sqlite.close();
  });

  it('порядок выдачи: точное → суффикс → вхождение', async () => {
    const { sqlite, db } = makeDb();
    addEngine(sqlite, 'e-suffix', { engineNumber: 'Э06АТ0889' });
    addEngine(sqlite, 'e-exact', { engineNumber: '0889' });
    addEngine(sqlite, 'e-substring', { engineNumber: 'Э06АТ0889-12' });
    addEngine(sqlite, 'e-other', { engineNumber: 'Э06АТ0777' });

    const suggestions = await suggestEnginesByNumberFragment(db, { q: '0889' });
    expect(suggestions.map((s) => s.id)).toEqual(['e-exact', 'e-suffix', 'e-substring']);
    sqlite.close();
  });

  it('слово подсказок не даёт — иначе они мешали бы искать по содержимому', async () => {
    const { sqlite, db } = makeDb();
    addEngine(sqlite, 'e-1', { engineNumber: 'Э06АТ0889' });

    expect(await suggestEnginesByNumberFragment(db, { q: 'акт' })).toEqual([]);
    expect(await suggestEnginesByNumberFragment(db, { q: 'приёмка' })).toEqual([]);
    expect(await suggestEnginesByNumberFragment(db, { q: 'Э06АТ0889' })).toEqual([]);
    sqlite.close();
  });

  it('короткий ввод подсказок не даёт — «088» ещё не номер', async () => {
    const { sqlite, db } = makeDb();
    addEngine(sqlite, 'e-1', { engineNumber: 'Э06АТ0889' });

    expect(await suggestEnginesByNumberFragment(db, { q: '088' })).toEqual([]);
    sqlite.close();
  });

  it('двигатель из строгой реплики тоже находится', async () => {
    const { sqlite, db } = makeDb();
    addStrictEngine(sqlite, 'e-strict', 'Э06АТ0777');

    const suggestions = await suggestEnginesByNumberFragment(db, { q: '0777' });
    expect(suggestions.map((s) => s.engineNumber)).toEqual(['Э06АТ0777']);
    sqlite.close();
  });

  it('подсказка несёт внутренний номер и номер РМЗ', async () => {
    const { sqlite, db } = makeDb();
    addEngine(sqlite, 'e-1', { engineNumber: 'Э06АТ0889', internalNumber: '41', internalNumberYear: 2026 });
    sqlite
      .prepare(`INSERT INTO erp_engine_numbers (id, seq, created_at, updated_at) VALUES (?,?,1,1)`)
      .run('e-1', 451);

    const suggestions = await suggestEnginesByNumberFragment(db, { q: '0889' });
    expect(suggestions[0]?.internalNumberFull).toBe('41/26');
    expect(suggestions[0]?.rmzCode).toBe('RMZ451');
    sqlite.close();
  });

  it('лимит ограничивает выдачу', async () => {
    const { sqlite, db } = makeDb();
    for (let i = 0; i < 5; i += 1) addEngine(sqlite, `e-${i}`, { engineNumber: `Э06АТ${i}0889` });

    const suggestions = await suggestEnginesByNumberFragment(db, { q: '0889', limit: 2 });
    expect(suggestions).toHaveLength(2);
    sqlite.close();
  });
});
