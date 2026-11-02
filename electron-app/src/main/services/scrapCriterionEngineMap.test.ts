import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ENGINE_INVENTORY_STAGE, REPAIR_HISTORY_OPERATION_TYPE } from '@matricarmz/shared';

import { getScrapCriterionEngineMap } from './engineService.js';
import { seedScrapCriterionParts } from './scrapCriterionService.js';

/**
 * Признак «утилен по деталям» в местах, где раньше читались только карточные
 * метки (гейт сборочного наряда, наряд, отчёты).
 *
 * Проверяем на настоящей базе в памяти: набор критериев читается из EAV
 * (`scrap_criterion` на детали), строки утильных деталей — из реплики списка
 * деталей двигателя. Снятие утиля (история ремонта) гасит признак.
 *
 * Каждый тест — свои id и свои метки времени: карты флагов акта, истории
 * ремонта и набора критериев кэшируются в модуле по id/времени, и общие id
 * между тестами маскировали бы разные сценарии одним и тем же кэшем.
 */

let clock = 1000;
const nextStamp = () => (clock += 10);

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE entity_types (id text PRIMARY KEY, code text NOT NULL, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_defs (id text PRIMARY KEY, entity_type_id text NOT NULL, code text NOT NULL,
      name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT false,
      sort_order integer NOT NULL DEFAULT 0, meta_json text, created_at integer NOT NULL,
      updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_values (id text PRIMARY KEY, entity_id text NOT NULL, attribute_def_id text NOT NULL,
      value_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE entities (id text PRIMARY KEY, type_id text NOT NULL, created_at integer NOT NULL,
      updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE erp_nomenclature (id text PRIMARY KEY, name text NOT NULL, code text NOT NULL DEFAULT '',
      directory_kind text, directory_ref_id text, created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
      status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE erp_engine_inventory_lines (
      id text PRIMARY KEY NOT NULL, operation_id text NOT NULL, engine_entity_id text NOT NULL,
      line_key text NOT NULL, sort_order integer NOT NULL, part_id text,
      brand_managed integer NOT NULL DEFAULT false, part_name text NOT NULL DEFAULT '',
      assembly_unit_number text NOT NULL DEFAULT '', part_number text NOT NULL DEFAULT '',
      stamped_number text NOT NULL DEFAULT '', bom_variant_group text,
      quantity integer NOT NULL DEFAULT 0, present integer NOT NULL DEFAULT false,
      actual_qty integer NOT NULL DEFAULT 0, repairable_qty integer NOT NULL DEFAULT 0,
      scrap_qty integer NOT NULL DEFAULT 0, replace_qty integer NOT NULL DEFAULT 0,
      replenishment_branch text, scrap_reason text NOT NULL DEFAULT '',
      in_completeness_act integer, in_defect_act integer, in_completeness_act_override integer,
      in_defect_act_override integer, has_own_number integer, has_own_number_override integer,
      selected integer NOT NULL DEFAULT false, photos_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE sync_state (key text PRIMARY KEY, value text NOT NULL, updated_at integer NOT NULL);
  `);
  return { sqlite, db: drizzle(sqlite) as any };
}

type Fixture = {
  sqlite: Database.Database;
  db: any;
  engineId: string;
  opId: string;
};

/** Деталь-критерий: на карточке детали стоит метка `scrap_criterion`. */
function markCriterion(fx: Fixture, partId: string, value = 'true') {
  const at = nextStamp();
  fx.sqlite
    .prepare("INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('tp-part', 'part', 'Детали', 1, 1)")
    .run();
  fx.sqlite
    .prepare(
      "INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at) VALUES ('def-scrap', 'tp-part', 'scrap_criterion', 'Уводит двигатель в утиль', 'boolean', 1, 1)",
    )
    .run();
  fx.sqlite
    .prepare("INSERT INTO entities (id, type_id, created_at, updated_at) VALUES (?, 'tp-part', 1, 1)")
    .run(partId);
  fx.sqlite
    .prepare(
      "INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES (?, ?, 'def-scrap', ?, ?, ?)",
    )
    .run(`av-${partId}`, partId, value, at, at);
  fx.sqlite
    .prepare(
      "INSERT INTO erp_nomenclature (id, name, code, directory_kind, directory_ref_id, created_at, updated_at) VALUES (?, 'Блок цилиндров', 'det-cyl', 'part', ?, 1, 1)",
    )
    .run(`nom-${partId}`, partId);
}

/** Акт дефектовки: деталь ушла в утиль. */
function addScrapLine(fx: Fixture, opts: { partId: string | null; partName: string }) {
  const at = nextStamp();
  const payload = {
    kind: 'repair_checklist',
    templateId: 'engine_inventory_default',
    templateVersion: 1,
    stage: ENGINE_INVENTORY_STAGE,
    engineEntityId: fx.engineId,
    filledBy: 'tester',
    filledAt: null,
    answers: { engine_inventory_items: { kind: 'table', rows: [] } },
  };
  fx.sqlite
    .prepare(
      "INSERT INTO operations (id, engine_entity_id, operation_type, status, meta_json, created_at, updated_at) VALUES (?, ?, ?, 'done', ?, ?, ?)",
    )
    .run(fx.opId, fx.engineId, ENGINE_INVENTORY_STAGE, JSON.stringify(payload), at, at);
  fx.sqlite
    .prepare(
      "INSERT INTO erp_engine_inventory_lines (id, operation_id, engine_entity_id, line_key, sort_order, part_id, part_name, scrap_qty, created_at, updated_at) VALUES (?, ?, ?, 'k1', 0, ?, ?, 1, ?, ?)",
    )
    .run(`l-${fx.opId}`, fx.opId, fx.engineId, opts.partId, opts.partName, at, at);
}

/** Снятие утиля: деталь отремонтировали (след в истории ремонта). */
function addScrapResolved(fx: Fixture, atMs: number) {
  const at = nextStamp();
  fx.sqlite
    .prepare(
      "INSERT INTO operations (id, engine_entity_id, operation_type, status, meta_json, created_at, updated_at) VALUES (?, ?, ?, 'done', ?, ?, ?)",
    )
    .run(
      `hist-${fx.opId}`,
      fx.engineId,
      REPAIR_HISTORY_OPERATION_TYPE,
      JSON.stringify({
        kind: 'repair_history',
        action: 'Блок цилиндров отремонтирован',
        scrapResolved: { outcome: 'repaired', partLabel: 'Блок цилиндров', atMs },
      }),
      at,
      at,
    );
}

function fixture(): Fixture {
  const { sqlite, db } = makeDb();
  const suffix = nextStamp();
  return { sqlite, db, engineId: `engine-${suffix}`, opId: `op-${suffix}` };
}

describe('признак «утилен по деталям» вне списка двигателей', () => {
  it('деталь-критерий в утиле делает двигатель утильным', async () => {
    const fx = fixture();
    markCriterion(fx, 'part-cyl');
    addScrapLine(fx, { partId: 'nom-part-cyl', partName: 'Блок цилиндров' });

    const map = await getScrapCriterionEngineMap(fx.db, [fx.engineId]);
    expect(map.get(fx.engineId)).toBe(true);
  });

  it('чужая деталь в утиле двигатель утильным не делает', async () => {
    const fx = fixture();
    markCriterion(fx, 'part-cyl');
    addScrapLine(fx, { partId: 'nom-other', partName: 'Форсунка' });

    const map = await getScrapCriterionEngineMap(fx.db, [fx.engineId]);
    expect(map.get(fx.engineId)).toBeUndefined();
  });

  it('без набора критериев утильным остаётся только старый картер', async () => {
    const fx = fixture();
    addScrapLine(fx, { partId: null, partName: 'Картер верхний' });

    const map = await getScrapCriterionEngineMap(fx.db, [fx.engineId]);
    expect(map.get(fx.engineId), 'старое правило D-#9 живёт до переноса картера в галку').toBe(true);
  });

  it('снятая метка на детали утильным двигатель не делает', async () => {
    const fx = fixture();
    markCriterion(fx, 'part-cyl', 'false');
    addScrapLine(fx, { partId: 'nom-part-cyl', partName: 'Блок цилиндров' });

    const map = await getScrapCriterionEngineMap(fx.db, [fx.engineId]);
    expect(map.get(fx.engineId)).toBeUndefined();
  });

  it('снятие утиля гасит признак по детали', async () => {
    const fx = fixture();
    markCriterion(fx, 'part-cyl');
    addScrapLine(fx, { partId: 'nom-part-cyl', partName: 'Блок цилиндров' });
    // Деталь отремонтировали позже дефектовки — утиль снят.
    addScrapResolved(fx, 5000);

    const map = await getScrapCriterionEngineMap(fx.db, [fx.engineId], {
      defectDateByEngineId: new Map([[fx.engineId, 1000]]),
    });
    expect(map.get(fx.engineId), 'снятие позже источника — утиль снят').toBeUndefined();
  });

  it('снятие раньше дефектовки утиль оставляет', async () => {
    const fx = fixture();
    markCriterion(fx, 'part-cyl');
    addScrapLine(fx, { partId: 'nom-part-cyl', partName: 'Блок цилиндров' });
    addScrapResolved(fx, 500);

    const map = await getScrapCriterionEngineMap(fx.db, [fx.engineId], {
      defectDateByEngineId: new Map([[fx.engineId, 1000]]),
    });
    expect(map.get(fx.engineId), 'деталь починили ДО дефектовки — утиль стоит').toBe(true);
  });
});

describe('наполнение набора критериями по умолчанию', () => {
  it('картерная деталь получает метку и становится критерием', async () => {
    const fx = fixture();
    // Справочник деталей: картер и ещё одна деталь.
    fx.sqlite
      .prepare(
        "INSERT INTO erp_nomenclature (id, name, code, directory_kind, directory_ref_id, created_at, updated_at) VALUES ('nom-carter', 'Картер верхний', 'det-carter', 'part', 'part-carter', 1, 1)",
      )
      .run();
    fx.sqlite
      .prepare(
        "INSERT INTO erp_nomenclature (id, name, code, directory_kind, directory_ref_id, created_at, updated_at) VALUES ('nom-inj', 'Форсунка', 'det-inj', 'part', 'part-inj', 1, 1)",
      )
      .run();
    fx.sqlite
      .prepare("INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('tp-part', 'x', 1, 1)")
      .run();
    fx.sqlite.prepare("DELETE FROM entities WHERE id = 'tp-part'").run();
    fx.sqlite
      .prepare("INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('tp-part', 'part', 'Детали', 1, 1)")
      .run();

    const seeded = await seedScrapCriterionParts(fx.db);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.parts.map((p) => p.name)).toEqual(['Картер верхний']);

    // Второй раз наполнение не повторяет: снятую метку не вернуть.
    const again = await seedScrapCriterionParts(fx.db);
    expect(again.ok && again.skipped).toBe('already-seeded');
  });
});
