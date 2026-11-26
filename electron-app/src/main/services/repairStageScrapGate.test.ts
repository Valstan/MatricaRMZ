import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REPAIR_STAGE_TEMPLATES } from '@matricarmz/shared';

import { listRepairStageRows, saveRepairStageRow } from './repairStageService.js';

// ГЕЙТ УТИЛЯ В ВОРОНКЕ ЗАПИСИ ЭТАПА (промт КАРМАНА #170).
//
// Проверяем то, что видит оператор: этап у утильного двигателя НЕ заводится (и в истории
// ремонта не остаётся), неремонтный этап заводится, утиль прошлого заезда текущую работу
// не держит, а неглавная утильная деталь даёт подсказку, а не запрет.

const DDL = `
  CREATE TABLE entities (id text PRIMARY KEY, type_id text,
    created_at integer NOT NULL DEFAULT 0, updated_at integer NOT NULL DEFAULT 0,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
    status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_defs (id text PRIMARY KEY, entity_type_id text NOT NULL, code text NOT NULL,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_values (id text PRIMARY KEY, entity_id text NOT NULL,
    attribute_def_id text NOT NULL, value_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
`;

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  return { sqlite, db: drizzle(sqlite) as never };
}

const DAY = 86_400_000;
const ARRIVAL = Date.UTC(2026, 8, 1, 9, 0, 0);
const DEFECT = ARRIVAL + 2 * DAY;
const UTIL_AT = ARRIVAL + 3 * DAY;
const STAGE_AT = ARRIVAL + 5 * DAY;

/** Карточка двигателя: флаги статуса и их даты (EAV). */
function seedAttrs(db: never, values: Record<string, unknown>) {
  const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client;
  const insertDef = sqlite.prepare(
    'INSERT OR REPLACE INTO attribute_defs (id, entity_type_id, code) VALUES (?, ?, ?)',
  );
  const insertVal = sqlite.prepare(
    'INSERT OR REPLACE INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const [code, value] of Object.entries(values)) {
    const defId = `def-${code}`;
    insertDef.run(defId, 'engine-type', code);
    // Значение привязано к определению: повторный вызов ЗАМЕНЯЕТ значение (а не добавляет).
    insertVal.run(`val-${code}`, 'eng-1', defId, JSON.stringify(value), 1, 1);
  }
}

/** Акт дефектовки: строки листа с утильными деталями (источник подсказки). */
function seedDefectAct(db: never, rows: Array<{ partId: string; partName: string }>) {
  const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client;
  const payload = {
    answers: {
      engine_inventory_items: {
        kind: 'table',
        rows: rows.map((r) => ({
          part_id: r.partId,
          part_name: r.partName,
          present: 0,
          scrap_qty: 1,
          replace_qty: 0,
        })),
      },
    },
  };
  sqlite
    .prepare(
      'INSERT INTO operations (id, engine_entity_id, operation_type, status, note, performed_at, performed_by, meta_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('act-1', 'eng-1', 'engine_inventory', 'done', 'акт', DEFECT, 'tester', JSON.stringify(payload), DEFECT, DEFECT);
}

describe('гейт утиля в воронке записи этапа', () => {
  it('у утильного двигателя этап ремонта не создаётся и в истории не остаётся', async () => {
    const { db } = makeDb();
    seedAttrs(db, {
      engine_number: 'Д-001',
      status_scrap_confirmed: true,
      status_scrap_confirmed_date: UTIL_AT,
    });
    const res = await saveRepairStageRow(
      db,
      { id: 's-ukladka', engineId: 'eng-1', code: 'ukladka', atMs: STAGE_AT },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.scrapGate).toBeTruthy();
    expect(res.scrapGate?.stageName).toBe('Укладка вала');
    expect(res.scrapGate?.engineNumber).toBe('Д-001');
    expect(res.error).toContain('утильный');
    // В истории ремонта этапа нет.
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(0);
  });

  it('неремонтный этап у утильного двигателя заводится', async () => {
    const { db } = makeDb();
    seedAttrs(db, { status_scrap_confirmed: true, status_scrap_confirmed_date: UTIL_AT });
    const res = await saveRepairStageRow(
      db,
      { id: 's-arrival', engineId: 'eng-1', code: 'arrival', atMs: ARRIVAL },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);
  });

  it('у неутильного двигателя этап ремонта заводится', async () => {
    const { db } = makeDb();
    seedAttrs(db, { engine_number: 'Д-002' });
    const res = await saveRepairStageRow(
      db,
      { id: 's-ukladka', engineId: 'eng-1', code: 'ukladka', atMs: STAGE_AT },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);
  });

  it('утиль прошлого заезда текущую работу не держит', async () => {
    const { db } = makeDb();
    // Приёмка (граница заезда) — позже утиля: утиль остался в прошлом заезде.
    seedAttrs(db, { status_scrap_confirmed: true, status_scrap_confirmed_date: ARRIVAL - 2 * DAY });
    await saveRepairStageRow(
      db,
      { id: 's-arrival', engineId: 'eng-1', code: 'arrival', atMs: ARRIVAL },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    const res = await saveRepairStageRow(
      db,
      { id: 's-ukladka', engineId: 'eng-1', code: 'ukladka', atMs: STAGE_AT },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);
  });

  it('утильная неглавная деталь не держит этап, но подсказка видна', async () => {
    const { db } = makeDb();
    seedAttrs(db, { engine_number: 'Д-003', defect_date: DEFECT });
    seedDefectAct(db, [{ partId: 'nom-oil', partName: 'Маслонасос' }]);
    const res = await saveRepairStageRow(
      db,
      { id: 's-obkatka', engineId: 'eng-1', code: 'obkatka', atMs: STAGE_AT },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scrapHint).toBe('В дефектовке есть утильная деталь');
  });

  it('этап снятия утиля в истории гасит утиль: после снятия этап заводится', async () => {
    const { db } = makeDb();
    seedAttrs(db, { engine_number: 'Д-004', status_scrap_confirmed: true, status_scrap_confirmed_date: UTIL_AT });
    const blocked = await saveRepairStageRow(
      db,
      { id: 's-ukladka', engineId: 'eng-1', code: 'ukladka', atMs: STAGE_AT },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(blocked.ok).toBe(false);
    // Снятие утиля — след в истории с моментом события после источника утиля.
    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client;
    sqlite
      .prepare(
        'INSERT INTO operations (id, engine_entity_id, operation_type, status, note, performed_at, performed_by, meta_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'hist-1',
        'eng-1',
        'repair_history_entry',
        'done',
        'Картер отремонтирован',
        UTIL_AT + DAY,
        'tester',
        JSON.stringify({
          kind: 'repair_history',
          action: 'Картер отремонтирован',
          scrapResolved: { outcome: 'repaired', partLabel: 'Картер', reason: 'Ремонт', atMs: UTIL_AT + DAY },
          at: UTIL_AT + DAY,
        }),
        UTIL_AT + DAY,
        UTIL_AT + DAY,
      );
    // Флаг карточки снимает действие снятия утиля; гейт смотрит и на статус, и на след.
    seedAttrs(db, { status_scrap_confirmed: false });
    const res = await saveRepairStageRow(
      db,
      { id: 's-ukladka-2', engineId: 'eng-1', code: 'ukladka', atMs: STAGE_AT },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.ok).toBe(true);
  });
});
