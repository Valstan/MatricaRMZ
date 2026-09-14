import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { STATUS_CODES, STATUS_DATE_CODES, parseRepairHistoryMeta, type WorkSheetType } from '@matricarmz/shared';

import { deleteWorkSheetRow, listWorkSheetRows, saveWorkSheetRow } from './workSheetService.js';

// Ведомости работ (15.09.2026): строка = запись истории ремонта, id даёт клиент, правка бьёт в
// ту же строку. Узел «завершает ремонт» ставит «Отремонтирован» датой строки — один раз и
// только при добавлении; утиль и уже отремонтированный не трогаются.

const DDL = `
  CREATE TABLE entity_types (id text PRIMARY KEY, code text NOT NULL, name text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE entities (id text PRIMARY KEY, type_id text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_defs (id text PRIMARY KEY, entity_type_id text NOT NULL, code text NOT NULL,
    name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0,
    sort_order integer NOT NULL DEFAULT 0, meta_json text, created_at integer NOT NULL,
    updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
    sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_values (id text PRIMARY KEY, entity_id text NOT NULL, attribute_def_id text NOT NULL,
    value_json text, created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
    status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
`;

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  sqlite.prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`).run('et-engine', 'engine', 'Двигатель', 1, 1);
  const codes = [...STATUS_CODES, ...Object.values(STATUS_DATE_CODES), 'engine_number', 'engine_brand'];
  for (const [i, code] of codes.entries()) {
    sqlite
      .prepare(`INSERT INTO attribute_defs (id,entity_type_id,code,name,data_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(`def-${code}`, 'et-engine', code, code, code.endsWith('_date') ? 'date' : 'text', i, i);
  }
  sqlite.prepare(`INSERT INTO entities (id,type_id,created_at,updated_at) VALUES (?,?,?,?)`).run('eng-1', 'et-engine', 1, 1);
  sqlite
    .prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('v-num', 'eng-1', 'def-engine_number', JSON.stringify('ДВ-1'), 1, 1);
  return { sqlite, db: drizzle(sqlite) as never };
}

function attr(sqlite: Database.Database, engineId: string, code: string): unknown {
  const row = sqlite.prepare(`SELECT value_json FROM attribute_values WHERE entity_id = ? AND attribute_def_id = ?`).get(engineId, `def-${code}`) as
    | { value_json: string }
    | undefined;
  return row ? JSON.parse(row.value_json) : undefined;
}

const OBKATKA: SaveInputType = {
  id: 't-obk',
  code: 'obkatka',
  name: 'Обкатка',
  completesRepair: true,
  workshopId: null,
  columns: [{ code: 'hours', label: 'Часы', type: 'number' }],
};
const UKLADKA: SaveInputType = { id: 't-ukl', code: 'ukladka', name: 'Укладка', completesRepair: false, workshopId: 'W1', columns: [] };
type SaveInputType = Pick<WorkSheetType, 'id' | 'code' | 'name' | 'completesRepair' | 'columns' | 'workshopId'>;

const AT = Date.parse('2026-09-10T00:00:00');

describe('строка ведомости', () => {
  it('ложится записью истории с полями узла и датой строки', async () => {
    const { sqlite, db } = makeDb();
    const r = await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: UKLADKA, atMs: AT, values: {} }, 'ivanov');
    expect(r).toMatchObject({ ok: true, created: true, repair: null });
    const op = sqlite.prepare(`SELECT * FROM operations WHERE id = 'row-1'`).get() as any;
    expect(op.operation_type).toBe('repair_history_entry');
    expect(op.sync_status).toBe('pending');
    const meta = parseRepairHistoryMeta(op.meta_json)!;
    expect(meta.entryType).toBe('sheet');
    expect(meta.sheet?.typeCode).toBe('ukladka');
    expect(meta.at).toBe(AT);
    expect(meta.workshopId).toBe('W1');
  });

  it('повторное сохранение с тем же id — правка, не дубль', async () => {
    const { db } = makeDb();
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: { hours: '4' } }, 'ivanov');
    const r = await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: { hours: '6' } }, 'ivanov');
    expect(r).toMatchObject({ ok: true, created: false });
    const rows = await listWorkSheetRows(db);
    expect(rows.filter((x) => x.typeCode === 'obkatka')).toHaveLength(1);
    expect(rows[0]?.fields).toEqual([{ code: 'hours', label: 'Часы', type: 'number', value: 6 }]);
    expect(rows[0]?.engineNumber).toBe('ДВ-1');
  });

  it('обкатка ставит «Отремонтирован» датой строки и пишет автозапись стадии — один раз', async () => {
    const { sqlite, db } = makeDb();
    const r = await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: { hours: 4 } }, 'ivanov');
    expect(r).toMatchObject({ ok: true, repair: { applied: true } });
    expect(attr(sqlite, 'eng-1', 'status_repaired')).toBe(true);
    expect(attr(sqlite, 'eng-1', 'status_repaired_date')).toBe(AT);
    const statusRows = sqlite.prepare(`SELECT meta_json FROM operations WHERE id <> 'row-1'`).all() as Array<{ meta_json: string }>;
    expect(statusRows).toHaveLength(1);
    const meta = parseRepairHistoryMeta(statusRows[0]!.meta_json)!;
    expect(meta.entryType).toBe('status');
    expect(meta.action).toBe('Отремонтирован');
    expect(meta.at).toBe(AT);

    // Правка строки и вторая обкатка статус не трогают: дата ремонта — первая обкатка.
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT + 1000, values: { hours: 5 } }, 'ivanov');
    const second = await saveWorkSheetRow(db, { id: 'row-2', engineId: 'eng-1', type: OBKATKA, atMs: AT + 86_400_000, values: { hours: 2 } }, 'ivanov');
    expect(second).toMatchObject({ ok: true, repair: { applied: false, reason: 'already-repaired' } });
    expect(attr(sqlite, 'eng-1', 'status_repaired_date')).toBe(AT);
    expect((sqlite.prepare(`SELECT count(*) AS n FROM operations`).get() as { n: number }).n).toBe(3);
  });

  it('утильный двигатель обкаткой не «ремонтируется»', async () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run('v-scrap', 'eng-1', 'def-status_scrap_confirmed', 'true', 1, 1);
    const r = await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: {} }, 'ivanov');
    expect(r).toMatchObject({ ok: true, repair: { applied: false, reason: 'scrap-engine' } });
    expect(attr(sqlite, 'eng-1', 'status_repaired')).toBeUndefined();
  });

  it('обязательная колонка без значения не даёт сохранить', async () => {
    const { db } = makeDb();
    const type: SaveInputType = { ...UKLADKA, columns: [{ code: 'master', label: 'Мастер', type: 'text', required: true }] };
    const r = await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type, atMs: AT, values: {} }, 'ivanov');
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('Мастер');
  });

  it('ручную запись истории через ведомость не переписать и не удалить', async () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare(`INSERT INTO operations (id,engine_entity_id,operation_type,status,meta_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run('manual-1', 'eng-1', 'repair_history_entry', 'done', JSON.stringify({ kind: 'repair_history', action: 'Своё' }), 1, 1);
    const r = await saveWorkSheetRow(db, { id: 'manual-1', engineId: 'eng-1', type: UKLADKA, atMs: AT, values: {} }, 'ivanov');
    expect(r.ok).toBe(false);
    expect((await deleteWorkSheetRow(db, 'manual-1')).ok).toBe(false);
  });

  it('удаление — мягкое, строка уходит из списка', async () => {
    const { sqlite, db } = makeDb();
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: UKLADKA, atMs: AT, values: {} }, 'ivanov');
    expect((await deleteWorkSheetRow(db, 'row-1')).ok).toBe(true);
    expect(await listWorkSheetRows(db)).toHaveLength(0);
    expect((sqlite.prepare(`SELECT deleted_at FROM operations WHERE id = 'row-1'`).get() as any).deleted_at).toBeTruthy();
  });
});
