import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName, type SyncPushRequest } from '@matricarmz/shared';

import { applyPushBatch, type AppliedSyncChange } from './applyPushBatch.js';
import { entities } from '../../database/schema.js';
import { makeInsertChain, makeTxSelectFromTableMap } from '../../tests/utils/dbMockHelpers.js';

// История — часть карточки (владелец 10.10.2026): push операций двигает updatedAt
// сущностей и подписывает его в журнал, иначе «дата изменения» списка у машин,
// не видевших правку, стоит на месте.
const EID = '11111111-1111-1111-1111-111111111111';
const TID = '22222222-2222-2222-2222-222222222222';
const ACTOR = '33333333-3333-3333-3333-333333333333';

const txRowsByTable = new Map<unknown, any[]>();

const txMock = {
  insert: vi.fn(() => makeInsertChain()),
  select: vi.fn(),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => ({})),
    })),
  })),
};

vi.mock('../../ledger/ledgerService.js', () => ({
  getLedgerLastSeq: vi.fn(async () => 0),
  signAndAppendDetailed: vi.fn(async () => ({ applied: 0, lastSeq: 0, blockHeight: 0, signed: [] })),
}));

vi.mock('../../database/db.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
          limit: vi.fn(async () => []),
        })),
        orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        limit: vi.fn(async () => []),
      })),
    })),
    transaction: vi.fn(async (cb: any) => cb(txMock)),
  },
}));

function opReq(): SyncPushRequest {
  return {
    client_id: 'c1',
    upserts: [
      {
        table: SyncTableName.Operations,
        rows: [
          {
            id: '44444444-4444-4444-4444-444444444444',
            engine_entity_id: EID,
            operation_type: 'repair_history_entry',
            status: 'done',
            note: 'n',
            performed_at: 100,
            performed_by: 'ivanov',
            meta_json: null,
            created_at: 100,
            updated_at: 100,
            deleted_at: null,
            sync_status: 'pending',
          },
        ],
      },
    ],
  };
}

describe('touch сущности push-ем операций', () => {
  beforeEach(() => {
    txRowsByTable.clear();
    vi.clearAllMocks();
    txMock.select.mockImplementation(makeTxSelectFromTableMap(txRowsByTable));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('push истории трогает сущность и кладёт её в журнал', async () => {
    txRowsByTable.set(entities, [{ id: EID, typeId: TID, createdAt: 10, deletedAt: null }]);
    const changes: AppliedSyncChange[] = [];
    const r = await applyPushBatch(opReq(), { id: ACTOR, username: 'ivanov', role: 'user' }, { collectChanges: changes });
    expect(r.applied).toBeGreaterThan(0);
    const touched = changes.filter((c) => c.table === SyncTableName.Entities && c.rowId === EID);
    expect(touched).toHaveLength(1);
    expect(JSON.parse(String(touched.map((t) => t.payloadJson).at(0))).updated_at).toBeGreaterThan(10);
  });

  it('без collectChanges touch всё равно пишет updatedAt', async () => {
    txRowsByTable.set(entities, [{ id: EID, typeId: TID, createdAt: 10, deletedAt: null }]);
    const updateSpy = txMock.update;
    await applyPushBatch(opReq(), { id: ACTOR, username: 'ivanov', role: 'user' });
    const calls = updateSpy.mock.calls as unknown[][];
    const entityUpdates = calls.filter((call) => call[0] === entities);
    expect(entityUpdates.length).toBeGreaterThan(0);
  });

  it('удалённую сущность не трогаем', async () => {
    txRowsByTable.set(entities, [{ id: EID, typeId: TID, createdAt: 10, deletedAt: 50 }]);
    const changes: AppliedSyncChange[] = [];
    await applyPushBatch(opReq(), { id: ACTOR, username: 'ivanov', role: 'user' }, { collectChanges: changes });
    const touched = changes.filter((c) => c.table === SyncTableName.Entities && c.rowId === EID);
    expect(touched).toHaveLength(0);
  });
});
