import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

const selectQueue: unknown[][] = [];
function chain() {
  const c: any = {};
  c.from = () => c;
  c.where = () => c;
  c.limit = async () => selectQueue.shift() ?? [];
  c.then = (resolve: (v: unknown[]) => unknown) => resolve(selectQueue.shift() ?? []);
  return c;
}

vi.mock('../../database/db.js', () => ({
  db: {
    select: vi.fn(() => chain()),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(async () => ({ rows: [] })),
  },
  pool: { query: vi.fn(), end: vi.fn() },
}));

import { ENGINE_DELETE_REASON_REQUIRED, partitionEngineDeletesByReason } from './engineDeleteReasonGuard.js';
import type { SyncWriteInput } from './syncWriteService.js';

const ENGINE_TYPE = '11111111-1111-4111-8111-111111111111';
const PART_TYPE = '22222222-2222-4222-8222-222222222222';
const ENGINE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ENGINE_ID = '44444444-4444-4444-8444-444444444444';
const PART_ID = '55555555-5555-4555-8555-555555555555';

function entityDelete(id: string, typeId = ENGINE_TYPE): SyncWriteInput {
  return {
    type: 'upsert',
    table: SyncTableName.Entities,
    row_id: id,
    row: { id, type_id: typeId, deleted_at: 1_700_000_000_000 },
  };
}

function auditRow(entityId: string, reason: unknown, action = 'engine.delete'): SyncWriteInput {
  return {
    type: 'upsert',
    table: SyncTableName.AuditLog,
    row_id: `${entityId}-audit`,
    row: {
      id: `${entityId}-audit`,
      actor: 'oper',
      action,
      entity_id: entityId,
      payload_json: JSON.stringify({ reason }),
      deleted_at: null,
    },
  };
}

beforeEach(() => {
  selectQueue.length = 0;
  selectQueue.push([{ id: ENGINE_TYPE }]);
});

describe('гейт «удаление карточки двигателя без причины»', () => {
  it('двигатель без причины не удаляется — строка в карантин', async () => {
    const r = await partitionEngineDeletesByReason([entityDelete(ENGINE_ID)]);
    expect(r.skipped).toEqual([
      { table: SyncTableName.Entities, row_id: ENGINE_ID, reason: ENGINE_DELETE_REASON_REQUIRED },
    ]);
    expect(r.allowed).toEqual([]);
  });

  it('причина из того же батча пропускает удаление', async () => {
    const r = await partitionEngineDeletesByReason([
      entityDelete(ENGINE_ID),
      auditRow(ENGINE_ID, 'Заведена дважды, ошиблись маркой'),
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.allowed.map((i) => i.row_id)).toContain(ENGINE_ID);
  });

  it('причина, осевшая в PG раньше, тоже считается', async () => {
    selectQueue.push([{ entityId: ENGINE_ID, payload: JSON.stringify({ reason: 'Списали по ошибке' }) }]);
    const r = await partitionEngineDeletesByReason([entityDelete(ENGINE_ID)]);
    expect(r.skipped).toEqual([]);
    expect(r.allowed.map((i) => i.row_id)).toContain(ENGINE_ID);
  });

  it('пустая причина и пробелы причиной не считаются', async () => {
    const r = await partitionEngineDeletesByReason([
      entityDelete(ENGINE_ID),
      auditRow(ENGINE_ID, '   '),
      entityDelete(OTHER_ENGINE_ID),
      auditRow(OTHER_ENGINE_ID, ''),
    ]);
    expect(r.skipped.map((s) => s.row_id).sort()).toEqual([ENGINE_ID, OTHER_ENGINE_ID].sort());
  });

  it('причина другого двигателя не пропускает это удаление', async () => {
    const r = await partitionEngineDeletesByReason([
      entityDelete(ENGINE_ID),
      auditRow(OTHER_ENGINE_ID, 'Причина соседа'),
    ]);
    expect(r.skipped.map((s) => s.row_id)).toEqual([ENGINE_ID]);
  });

  it('чужие действия в аудите не выдают себя за причину удаления', async () => {
    const r = await partitionEngineDeletesByReason([
      entityDelete(ENGINE_ID),
      auditRow(ENGINE_ID, 'правил марку', 'ui.engine.edit_done'),
    ]);
    expect(r.skipped.map((s) => s.row_id)).toEqual([ENGINE_ID]);
  });

  it('удаление карточки не-двигателя гейтом не режется', async () => {
    const r = await partitionEngineDeletesByReason([entityDelete(PART_ID, PART_TYPE)]);
    expect(r.skipped).toEqual([]);
    expect(r.allowed.map((i) => i.row_id)).toEqual([PART_ID]);
  });

  it('обычная правка двигателя (без deleted_at) не режется', async () => {
    const r = await partitionEngineDeletesByReason([
      {
        type: 'upsert',
        table: SyncTableName.Entities,
        row_id: ENGINE_ID,
        row: { id: ENGINE_ID, type_id: ENGINE_TYPE, deleted_at: null },
      },
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.allowed).toHaveLength(1);
  });

  it('аудит с deleted_at не считается причиной: запись погашена', async () => {
    const audit = auditRow(ENGINE_ID, 'Причина');
    (audit.row as Record<string, unknown>).deleted_at = 1_700_000_000_001;
    const r = await partitionEngineDeletesByReason([entityDelete(ENGINE_ID), audit]);
    expect(r.skipped.map((s) => s.row_id)).toEqual([ENGINE_ID]);
  });

  it('батч без удалений двигателей не ходит в базу за типами', async () => {
    selectQueue.length = 0;
    const r = await partitionEngineDeletesByReason([entityDelete(PART_ID, PART_TYPE)]);
    expect(r.allowed).toHaveLength(1);
    expect(selectQueue).toHaveLength(0);
  });
});
