import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REPAIR_STAGE_TEMPLATES, parseRepairHistoryMeta } from '@matricarmz/shared';

import { getOperation } from './operationService.js';
import {
  listDeletedRepairStageRows,
  listRepairStageRows,
  restoreRepairStageRow,
  saveRepairStageRow,
  syncCardDateStageRow,
} from './repairStageService.js';

/**
 * Этап следует за датой карточки (промты КАРМАНА #133/#136, решение владельца 25.11.2026).
 *
 * Правило проверяется в обе стороны и в обе двери:
 *  - дата появилась → этап создан и помнит источник;
 *  - дата изменилась → этап пришёл к новой дате;
 *  - дата снята → этап погашен (выпал из истории) и его можно вернуть;
 *  - этап правили руками → авто-связь его не трогает.
 */

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

const DAY1 = Date.UTC(2026, 8, 28, 9, 0, 0);
const DAY2 = Date.UTC(2026, 8, 29, 9, 0, 0);

describe('этап следует за датой карточки', () => {
  it('дата в карточке появилась — этап создан и помнит источник', async () => {
    const { db } = makeDb();
    const res = await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY1, 'tester');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action).toBe('created');

    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe('arrival');
    expect(rows[0]?.at).toBe(DAY1);
    expect(rows[0]?.source).toEqual({ kind: 'card_date', attr: 'arrival_date' });
  });

  it('дата изменилась — этап пришёл к новой дате, источник остался', async () => {
    const { db } = makeDb();
    await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY1, 'tester');
    const res = await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY2, 'tester');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action).toBe('updated');

    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows[0]?.at).toBe(DAY2);
    expect(rows[0]?.source).toEqual({ kind: 'card_date', attr: 'arrival_date' });
  });

  it('дата не менялась — ничего не делали (идемпотентно)', async () => {
    const { db } = makeDb();
    await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY1, 'tester');
    const res = await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY1, 'tester');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action).toBe('kept');
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(1);
  });

  it('дата снята — этап погашен и выпал из истории, но строка осталась с пометкой', async () => {
    const { db } = makeDb();
    await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY1, 'tester');
    const res = await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', null, 'petrov');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action).toBe('extinguished');

    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(0);
    const gone = await listDeletedRepairStageRows(db, 'eng-1');
    expect(gone).toHaveLength(1);
    expect(gone[0]?.extinguished).toEqual({ attr: 'arrival_date', by: 'petrov', at: expect.any(Number) });
  });

  it('погашенный этап можно вернуть — он снова в истории', async () => {
    const { db } = makeDb();
    await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY1, 'tester');
    const res = await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', null, 'petrov');
    expect(res.ok).toBe(true);
    const gone = await listDeletedRepairStageRows(db, 'eng-1');
    const rowId = gone[0]?.id ?? '';

    const back = await restoreRepairStageRow(db, rowId);
    expect(back.ok).toBe(true);
    const live = await listRepairStageRows(db, 'eng-1');
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(rowId);
    expect(live[0]?.at).toBe(DAY1);
    // Пометка погашения снята: строка снова живая.
    expect(live[0]?.extinguished).toBeUndefined();
    expect(await listDeletedRepairStageRows(db, 'eng-1')).toHaveLength(0);
  });

  it('этап, который правили руками, авто-связь не трогает (решение владельца)', async () => {
    const { db } = makeDb();
    // Строка поставлена руками: следа источника у неё нет.
    await saveRepairStageRow(
      db,
      { id: 's1', engineId: 'eng-1', code: 'arrival', atMs: DAY1 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    const res = await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY2, 'tester');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action).toBe('skipped-manual');

    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows[0]?.at).toBe(DAY1);
    expect(rows[0]?.source).toBeUndefined();
  });

  it('ручная правка даты снимает связь с карточкой — и дальше авто её не трогает', async () => {
    const { db } = makeDb();
    await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY1, 'tester');
    const rowId = (await listRepairStageRows(db, 'eng-1'))[0]?.id ?? '';

    // Оператор правит дату этапа в ленте истории.
    const manual = await saveRepairStageRow(
      db,
      { id: rowId, engineId: 'eng-1', code: 'arrival', atMs: DAY2 },
      'operator',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(manual.ok).toBe(true);

    // Связь с карточкой снята: строка перестала быть её копией.
    const meta = parseRepairHistoryMeta(String((await getOperation(db, rowId))?.metaJson ?? 'null'));
    expect(meta?.source).toBeUndefined();

    // Дальше карточка эту строку не двигает и не гасит.
    const res = await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', null, 'tester');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action).toBe('skipped-manual');
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(1);
  });

  it('чужой атрибут не гасит этап: источник другой — этап не наш', async () => {
    const { db } = makeDb();
    await syncCardDateStageRow(db, 'eng-1', 'arrival', 'arrival_date', DAY1, 'tester');
    const res = await syncCardDateStageRow(db, 'eng-1', 'arrival', 'status_customer_sent_date', null, 'tester');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action).toBe('skipped-manual');
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(1);
  });
});
