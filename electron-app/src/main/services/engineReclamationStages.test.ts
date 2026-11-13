import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REPAIR_STAGE_TEMPLATES,
  RECLAMATION_ARRIVAL_STAGE_CODE,
  RECLAMATION_SHIPPED_STAGE_CODE,
} from '@matricarmz/shared';

import { listRepairStageRows } from './repairStageService.js';
import { syncEngineReclamationStages } from './engineReclamationStages.js';

// Приёмка и отправка по рекламации — этапы истории ремонта (владелец 11.11.2026 и
// 13.11.2026): приход по рекламации приравнивается к приёмке двигателя на заводе, а отправка
// после ремонта по рекламации — такой же участник процесса, как приёмка. Очередь заездов —
// источник правды, этапы — её материализация: рекламация появилась — этапы заведены,
// рекламацию убрали — этапы сняты.

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

const DAY_1 = Date.UTC(2026, 2, 17, 9, 0, 0);
const DAY_2 = Date.UTC(2026, 9, 27, 9, 0, 0);
const DAY_3 = Date.UTC(2026, 10, 15, 9, 0, 0);

const reclaim = (queueNo: number, acceptedAt: number | null, shippedAt: number | null = null) => ({
  queueNo,
  acceptedAt,
  shippedAt,
});

describe('приёмка по рекламации материализуется этапом ремонта', () => {
  it('рекламация с датой приёма — заводит этап с этой датой', async () => {
    const { db } = makeDb();
    const res = await syncEngineReclamationStages(
      db,
      'eng-1',
      [reclaim(1, DAY_1)],
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.errors).toEqual([]);
    expect(res.created).toBe(1);
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe(RECLAMATION_ARRIVAL_STAGE_CODE);
    expect(rows[0]?.at).toBe(DAY_1);
    expect(rows[0]?.name).toBe('Приемка двигателя на завод по рекламации');
    // Метка: строка порождена очередью — по ней её можно найти и снять.
    expect(rows[0]?.reclamationQueueNo).toBe(1);
  });

  it('повторный вызов с той же очередью ничего не меняет', async () => {
    const { db } = makeDb();
    await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    const again = await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.removed).toBe(0);
    expect(again.errors).toEqual([]);
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(1);
  });

  it('дата приёма поменялась — этап переписан, а не заведён заново', async () => {
    const { db } = makeDb();
    await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    const res = await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_2)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(res.updated).toBe(1);
    expect(res.created).toBe(0);
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.at).toBe(DAY_2);
  });

  it('рекламация убрана из очереди — этап снят', async () => {
    const { db } = makeDb();
    await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    const res = await syncEngineReclamationStages(db, 'eng-1', [], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(res.removed).toBe(1);
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(0);
  });

  it('рекламация без даты приёма — этапа нет: заезда ещё не было', async () => {
    const { db } = makeDb();
    const res = await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, null)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(res.created).toBe(0);
    expect(res.errors).toEqual([]);
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(0);
  });

  it('две рекламации — два этапа, по одному на заезд', async () => {
    const { db } = makeDb();
    const res = await syncEngineReclamationStages(
      db,
      'eng-1',
      [reclaim(1, DAY_1), reclaim(2, DAY_2)],
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.created).toBe(2);
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows.map((r) => r.reclamationQueueNo).sort()).toEqual([1, 2]);
  });

  it('этап без справочника — честный отказ, а не молчаливая потеря', async () => {
    const { db } = makeDb();
    const res = await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1)], 'tester', []);
    expect(res.created).toBe(0);
    expect(res.errors.length).toBe(2);
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(0);
  });
});

describe('отправка по рекламации материализуется этапом ремонта', () => {
  it('рекламация с датой отправки — заводит этап с этой датой', async () => {
    const { db } = makeDb();
    const res = await syncEngineReclamationStages(
      db,
      'eng-1',
      [reclaim(1, DAY_1, DAY_3)],
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(res.errors).toEqual([]);
    expect(res.created).toBe(2);
    const rows = await listRepairStageRows(db, 'eng-1');
    const shipped = rows.find((r) => r.code === RECLAMATION_SHIPPED_STAGE_CODE);
    expect(shipped?.at).toBe(DAY_3);
    expect(shipped?.name).toBe('Отгрузка двигателя заказчику по рекламации');
    expect(shipped?.reclamationQueueNo).toBe(1);
  });

  it('дата отправки без даты приёма — этап отправки всё равно заводится', async () => {
    const { db } = makeDb();
    const res = await syncEngineReclamationStages(
      db,
      'eng-1',
      [reclaim(1, null, DAY_3)],
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    // Очередь — источник правды: что в ней записано, то и в истории. Согласованность заезда
    // (приёмка раньше отправки) проверяет гейт самой очереди, а не материализация этапов.
    expect(res.created).toBe(1);
    expect(res.errors).toEqual([]);
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows.map((r) => r.code)).toEqual([RECLAMATION_SHIPPED_STAGE_CODE]);
  });

  it('повторный вызов с той же очередью ничего не меняет', async () => {
    const { db } = makeDb();
    await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1, DAY_3)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    const again = await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1, DAY_3)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.removed).toBe(0);
    expect(again.errors).toEqual([]);
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(2);
  });

  it('дата отправки поменялась — этап переписан, а не заведён заново', async () => {
    const { db } = makeDb();
    await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1, DAY_3)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    const res = await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1, DAY_2)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(res.updated).toBe(1);
    expect(res.created).toBe(0);
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows.find((r) => r.code === RECLAMATION_SHIPPED_STAGE_CODE)?.at).toBe(DAY_2);
  });

  it('дата отправки снята — этап отправки снят, приёмка осталась', async () => {
    const { db } = makeDb();
    await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1, DAY_3)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    const res = await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1, null)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(res.removed).toBe(1);
    const rows = await listRepairStageRows(db, 'eng-1');
    expect(rows.map((r) => r.code)).toEqual([RECLAMATION_ARRIVAL_STAGE_CODE]);
  });

  it('рекламация убрана из очереди — оба этапа сняты', async () => {
    const { db } = makeDb();
    await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1, DAY_3)], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    const res = await syncEngineReclamationStages(db, 'eng-1', [], 'tester', DEFAULT_REPAIR_STAGE_TEMPLATES);
    expect(res.removed).toBe(2);
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(0);
  });

  it('этап без справочника — честный отказ, а не молчаливая потеря', async () => {
    const { db } = makeDb();
    const res = await syncEngineReclamationStages(db, 'eng-1', [reclaim(1, DAY_1, DAY_3)], 'tester', []);
    expect(res.created).toBe(0);
    expect(res.errors.length).toBe(2);
    expect(await listRepairStageRows(db, 'eng-1')).toHaveLength(0);
  });
});
