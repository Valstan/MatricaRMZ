import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName, type SyncPushRequest } from '@matricarmz/shared';

import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { entities, entityTypes, operations } from '../database/schema.js';
import { makeInsertChain, makeTxSelectFromTableMap } from './utils/dbMockHelpers.js';

/**
 * Класс «строка создана локально, а на сервер не уехала» (план #114, шаг 29).
 *
 * Для `operations` конфликт по seq раньше ронял ВЕСЬ батч (`sync_conflict`): клиент
 * делал resetSyncState + полный pull, и очередь начиналась сначала — цикл. Теперь
 * конфликт — per-row отказ с именем `lww_rejected`: серверная копия новее, клиент
 * снимает `pending` и едет дальше.
 */

const ENGINE_ID = '11111111-1111-1111-1111-111111111111';
const OP_CONFLICT = '22222222-2222-2222-2222-222222222222';
const OP_FRESH = '33333333-3333-3333-3333-333333333333';

let txRowsByTable = new Map<unknown, any[]>();

const txMock = {
  insert: vi.fn(() => makeInsertChain()),
  select: vi.fn(),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => ({})),
    })),
  })),
};

vi.mock('../ledger/ledgerService.js', () => ({
  getLedgerLastSeq: vi.fn(async () => 0),
  signAndAppendDetailed: vi.fn(async () => ({ applied: 0, lastSeq: 0, blockHeight: 0, signed: [] })),
}));

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
          orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
        orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        limit: vi.fn(async () => []),
      })),
    })),
    transaction: vi.fn(async (cb: any) => cb(txMock)),
  },
}));

function opRow(id: string, lastServerSeq: number, updatedAt: number) {
  return {
    id,
    engine_entity_id: ENGINE_ID,
    operation_type: 'repair_history_entry',
    status: 'done',
    note: 'Снят с обкатки',
    performed_at: updatedAt,
    performed_by: 'tester',
    meta_json: JSON.stringify({ kind: 'repair_history', entryType: 'manual' }),
    created_at: 1,
    updated_at: updatedAt,
    last_server_seq: lastServerSeq,
    deleted_at: null,
    sync_status: 'pending',
  };
}

describe('push operations: конфликт по seq не роняет батч', () => {
  beforeEach(() => {
    txRowsByTable = new Map();
    vi.clearAllMocks();
    txMock.select.mockImplementation(makeTxSelectFromTableMap(txRowsByTable));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('одна конфликтная строка — остальные применяются, отказ назван lww_rejected', async () => {
    txRowsByTable.set(entityTypes, []);
    // Серверная копия первой строки новее присланной.
    txRowsByTable.set(operations, [
      {
        id: OP_CONFLICT,
        engineEntityId: ENGINE_ID,
        operationType: 'repair_history_entry',
        status: 'done',
        note: 'Серверная версия',
        performedAt: 5000,
        performedBy: 'server',
        metaJson: null,
        createdAt: 1,
        updatedAt: 5000,
        deletedAt: null,
        lastServerSeq: 10,
      },
    ]);
    txRowsByTable.set(entities, [{ id: ENGINE_ID, typeId: '44444444-4444-4444-4444-444444444444' }]);

    const req: SyncPushRequest = {
      client_id: 'c1',
      upserts: [
        {
          table: SyncTableName.Operations,
          rows: [opRow(OP_CONFLICT, 5, 1000), opRow(OP_FRESH, 11, 2000)],
        },
      ],
    };

    const res = await applyPushBatch(req, { id: 'actor-1', username: 'tester', role: 'engineer' });

    expect(res.applied).toBeGreaterThan(0);
    const skipped = res.skipped.filter((r: any) => r.table === SyncTableName.Operations);
    expect(skipped.map((r: any) => r.row_id)).toContain(OP_CONFLICT);
    expect(skipped.find((r: any) => r.row_id === OP_CONFLICT)?.reason).toBe('lww_rejected');
  });
});
