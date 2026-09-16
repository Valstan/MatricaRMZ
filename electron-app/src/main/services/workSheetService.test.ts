import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { STATUS_CODES, STATUS_DATE_CODES, parseRepairHistoryMeta, type WorkSheetType } from '@matricarmz/shared';

import { deleteWorkSheetRow, listWorkSheetRows, saveWorkSheetRow } from './workSheetService.js';

// Этапы работ (15.09.2026): строка = запись истории ремонта, id даёт клиент, правка бьёт в
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
  const codes = [
    ...STATUS_CODES,
    ...Object.values(STATUS_DATE_CODES),
    'engine_number',
    'engine_brand',
    'contract_id',
    'customer_id',
    'contract_section_number',
  ];
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

/**
 * Договор с заказчиком и привязка к двигателю. Заказчик ДОГОВОРА важнее поля карточки —
 * это единое правило проекта (`resolveEngineCustomer`), и этап работ обязан его соблюдать,
 * иначе он назовёт заказчика иначе, чем список двигателей и отчёты.
 */
function seedContract(sqlite: any, opts: { number: string; section?: string; short: string; full: string }) {
  const attrDef = (id: string, typeId: string, code: string) =>
    sqlite
      .prepare(`INSERT INTO attribute_defs (id,entity_type_id,code,name,data_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, typeId, code, code, 'text', 1, 1);
  const value = (id: string, entityId: string, defId: string, v: unknown) =>
    sqlite
      .prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(id, entityId, defId, JSON.stringify(v), 1, 1);

  sqlite.prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`).run('et-contract', 'contract', 'Договор', 1, 1);
  sqlite.prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`).run('et-customer', 'customer', 'Заказчик', 1, 1);
  attrDef('def-c-number', 'et-contract', 'number');
  attrDef('def-c-customer', 'et-contract', 'customer_id');
  attrDef('def-cu-name', 'et-customer', 'name');
  attrDef('def-cu-short', 'et-customer', 'short_name');
  sqlite.prepare(`INSERT INTO entities (id,type_id,created_at,updated_at) VALUES (?,?,?,?)`).run('con-1', 'et-contract', 1, 1);
  sqlite.prepare(`INSERT INTO entities (id,type_id,created_at,updated_at) VALUES (?,?,?,?)`).run('cus-1', 'et-customer', 1, 1);
  value('v-c-number', 'con-1', 'def-c-number', opts.number);
  value('v-c-customer', 'con-1', 'def-c-customer', 'cus-1');
  value('v-cu-name', 'cus-1', 'def-cu-name', opts.full);
  value('v-cu-short', 'cus-1', 'def-cu-short', opts.short);
  value('v-eng-contract', 'eng-1', 'def-contract_id', 'con-1');
  if (opts.section) value('v-eng-section', 'eng-1', 'def-contract_section_number', opts.section);
}

describe('строка этапа работ', () => {
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
    const { rows } = await listWorkSheetRows(db);
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

  // Откат честен только со штампом: история стадий неполна по построению, а карточка не
  // помнит, кто поставил статус. Строка запоминает свой след сама.
  it('удаление строки обкатки с подтверждением снимает «Отремонтирован» и гасит автозапись', async () => {
    const { sqlite, db } = makeDb();
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: { hours: 4 } }, 'ivanov');
    expect(attr(sqlite, 'eng-1', 'status_repaired')).toBe(true);
    const listed = await listWorkSheetRows(db);
    expect(listed.rows[0]?.repairStamped, 'строка знает, что ей есть что откатывать').toBe(true);

    const r = await deleteWorkSheetRow(db, 'row-1', { rollbackRepair: true }, 'ivanov');
    expect(r).toMatchObject({ ok: true, repairRolledBack: true });
    expect(attr(sqlite, 'eng-1', 'status_repaired')).toBe(false);
    expect(attr(sqlite, 'eng-1', 'status_repaired_date')).toBeNull();
    const live = sqlite.prepare(`SELECT count(*) AS n FROM operations WHERE deleted_at IS NULL`).get() as { n: number };
    expect(live.n, 'автозапись стадии гаснет вместе со статусом').toBe(0);
  });

  // Правка пересобирает meta целиком: без явного переноса штамп молча пропадал, и удаление
  // ПОСЛЕ правки уже нечего было откатывать. Поймано живым смоуком, не юнит-тестом.
  it('штамп переживает правку строки — откат после правки всё ещё возможен', async () => {
    const { sqlite, db } = makeDb();
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: { hours: 4 } }, 'ivanov');
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: { hours: 6 } }, 'ivanov');
    const { rows } = await listWorkSheetRows(db);
    expect(rows[0]?.repairStamped, 'после правки строка всё ещё знает свой след').toBe(true);

    const r = await deleteWorkSheetRow(db, 'row-1', { rollbackRepair: true }, 'ivanov');
    expect(r).toMatchObject({ ok: true, repairRolledBack: true });
    expect(attr(sqlite, 'eng-1', 'status_repaired')).toBe(false);
  });

  it('без подтверждения удаляется только строка — статус остаётся решением оператора', async () => {
    const { sqlite, db } = makeDb();
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: { hours: 4 } }, 'ivanov');
    const r = await deleteWorkSheetRow(db, 'row-1', { rollbackRepair: false }, 'ivanov');
    expect(r).toMatchObject({ ok: true, repairRolledBack: false });
    expect(attr(sqlite, 'eng-1', 'status_repaired')).toBe(true);
    expect(attr(sqlite, 'eng-1', 'status_repaired_date')).toBe(AT);
  });

  it('отметку после строки трогали в другом месте — откат её не затирает', async () => {
    const { sqlite, db } = makeDb();
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: { hours: 4 } }, 'ivanov');
    // Оператор снял и снова поставил отметку в карточке — теперь это его решение, не строки.
    sqlite.prepare(`UPDATE attribute_values SET value_json = 'false' WHERE entity_id = 'eng-1' AND attribute_def_id = 'def-status_repaired'`).run();

    const r = await deleteWorkSheetRow(db, 'row-1', { rollbackRepair: true }, 'ivanov');
    expect(r).toMatchObject({ ok: true, repairRolledBack: false, reason: 'changed-elsewhere' });
    expect(attr(sqlite, 'eng-1', 'status_repaired_date'), 'чужое значение не тронуто').toBe(AT);
  });

  it('строка, которая статус не ставила, штампа не несёт и откатывать ей нечего', async () => {
    const { sqlite, db } = makeDb();
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: OBKATKA, atMs: AT, values: { hours: 4 } }, 'ivanov');
    const second = await saveWorkSheetRow(db, { id: 'row-2', engineId: 'eng-1', type: OBKATKA, atMs: AT + 86_400_000, values: { hours: 2 } }, 'ivanov');
    expect(second).toMatchObject({ repair: { applied: false, reason: 'already-repaired' } });
    const { rows } = await listWorkSheetRows(db);
    expect(rows.find((x) => x.id === 'row-2')?.repairStamped).toBe(false);

    const r = await deleteWorkSheetRow(db, 'row-2', { rollbackRepair: true }, 'ivanov');
    expect(r).toMatchObject({ ok: true, repairRolledBack: false });
    expect(attr(sqlite, 'eng-1', 'status_repaired'), 'чужой «Отремонтирован» не трогаем').toBe(true);
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

  it('ручную запись истории через этап работ не переписать и не удалить', async () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare(`INSERT INTO operations (id,engine_entity_id,operation_type,status,meta_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run('manual-1', 'eng-1', 'repair_history_entry', 'done', JSON.stringify({ kind: 'repair_history', action: 'Своё' }), 1, 1);
    const r = await saveWorkSheetRow(db, { id: 'manual-1', engineId: 'eng-1', type: UKLADKA, atMs: AT, values: {} }, 'ivanov');
    expect(r.ok).toBe(false);
    expect((await deleteWorkSheetRow(db, 'manual-1')).ok).toBe(false);
  });

  // Строку заводят задним числом: запись, сделанную вчера о событии двухлетней давности,
  // «за последний год» показывать нельзя — иначе кнопка обещает одно, а показывает другое.
  it('окно «за год» считается по дате строки, а не по времени правки', async () => {
    const { db } = makeDb();
    const year = 365 * 24 * 60 * 60 * 1000;
    const now = AT;
    await saveWorkSheetRow(db, { id: 'row-old', engineId: 'eng-1', type: UKLADKA, atMs: now - 2 * year, values: {} }, 'ivanov');
    await saveWorkSheetRow(db, { id: 'row-new', engineId: 'eng-1', type: UKLADKA, atMs: now - 10 * 60 * 1000, values: {} }, 'ivanov');

    const windowed = await listWorkSheetRows(db, { sinceMs: now - year });
    expect(windowed.rows.map((r) => r.id)).toEqual(['row-new']);
    expect(windowed.truncated).toBe(false);

    // Обе строки правились только что — по времени правки в окно попали бы обе.
    expect((await listWorkSheetRows(db)).rows.map((r) => r.id).sort()).toEqual(['row-new', 'row-old']);
  });

  it('в строке — заказчик кратким именем и короткий номер договора из карточки двигателя', async () => {
    const { sqlite, db } = makeDb();
    seedContract(sqlite, {
      number: '2325187913551442245231239/27/ГОЗ-24',
      short: 'АО «Ромашка»',
      full: 'Акционерное общество «Ромашка»',
    });
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: UKLADKA, atMs: AT, values: {} }, 'ivanov');

    const { rows } = await listWorkSheetRows(db);
    expect(rows[0]?.customerName, 'в строке — краткое имя').toBe('АО «Ромашка»');
    expect(rows[0]?.customerFullName, 'полное остаётся для подсказки').toBe('Акционерное общество «Ромашка»');
    expect(rows[0]?.contractNumber).toBe('2325187913551442245231239/27/ГОЗ-24');
    expect(rows[0]?.contractShortLabel, 'три последние цифры части до «/»').toBe('*239');
  });

  it('раздел договора попадает в короткую метку', async () => {
    const { sqlite, db } = makeDb();
    seedContract(sqlite, { number: '239/27', section: 'ДС 2', short: 'АО «Р»', full: 'АО «Р»' });
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: UKLADKA, atMs: AT, values: {} }, 'ivanov');
    expect((await listWorkSheetRows(db)).rows[0]?.contractShortLabel).toBe('*239 / ДС 2');
  });

  it('двигатель без договора — пустые реквизиты, а не прочерк-заглушка', async () => {
    const { db } = makeDb();
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: UKLADKA, atMs: AT, values: {} }, 'ivanov');
    const { rows } = await listWorkSheetRows(db);
    expect(rows[0]?.customerName).toBe('');
    expect(rows[0]?.contractShortLabel).toBe('');
  });

  it('имя цеха читается снимком из самой строки — без справочника', async () => {
    const { db } = makeDb();
    await saveWorkSheetRow(
      db,
      { id: 'row-1', engineId: 'eng-1', type: UKLADKA, atMs: AT, workshopId: 'W1', workshopName: 'Цех № 4', values: {} },
      'ivanov',
    );
    const { rows } = await listWorkSheetRows(db);
    expect(rows[0]?.workshopId).toBe('W1');
    expect(rows[0]?.workshopName).toBe('Цех № 4');
  });

  it('удаление — мягкое, строка уходит из списка', async () => {
    const { sqlite, db } = makeDb();
    await saveWorkSheetRow(db, { id: 'row-1', engineId: 'eng-1', type: UKLADKA, atMs: AT, values: {} }, 'ivanov');
    expect((await deleteWorkSheetRow(db, 'row-1')).ok).toBe(true);
    expect((await listWorkSheetRows(db)).rows).toHaveLength(0);
    expect((sqlite.prepare(`SELECT deleted_at FROM operations WHERE id = 'row-1'`).get() as any).deleted_at).toBeTruthy();
  });
});
