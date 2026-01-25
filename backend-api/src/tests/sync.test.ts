import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName, type SyncPushRequest } from '@matricarmz/shared';

import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { pullChangesSince } from '../services/sync/pullChangesSince.js';
import { chatMessages, entityTypes } from '../database/schema.js';

let selectRows: any[] = [];
let txRowsByTable = new Map<unknown, any[]>();

function makeSelectChain(rowsFor: () => any[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(async () => rowsFor()),
        })),
        limit: vi.fn(async () => rowsFor()),
      })),
      orderBy: vi.fn(() => ({
        limit: vi.fn(async () => rowsFor()),
      })),
      limit: vi.fn(async () => rowsFor()),
    })),
  };
}

function makeInsertChain() {
  return {
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn().mockResolvedValue({}),
      onConflictDoNothing: vi.fn().mockResolvedValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
      returning: vi.fn().mockResolvedValue([]),
    })),
  };
}

const txMock = {
  insert: vi.fn(() => makeInsertChain()),
  select: vi.fn(),
  update: vi.fn(),
};

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(() => makeSelectChain(() => selectRows)),
    transaction: vi.fn(async (cb: any) => cb(txMock)),
  },
}));

describe('sync privacy and errors', () => {
  beforeEach(() => {
    selectRows = [];
    txRowsByTable = new Map();
    vi.clearAllMocks();
    txMock.select.mockImplementation(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          const rows = txRowsByTable.get(table) ?? [];
          const chained = Object.assign(Promise.resolve(rows), {
            limit: vi.fn(async () => rows),
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => rows),
            })),
          });
          return chained;
        }),
        orderBy: vi.fn(() => ({
          limit: vi.fn(async () => txRowsByTable.get(table) ?? []),
        })),
        limit: vi.fn(async () => txRowsByTable.get(table) ?? []),
      })),
    }));
  });

  it('pullChangesSince keeps chat privacy for non-admin', async () => {
    selectRows = [
      {
        table: SyncTableName.ChatMessages,
        rowId: 'm1',
        op: 'upsert',
        payloadJson: JSON.stringify({ sender_user_id: 'u1', recipient_user_id: 'u2' }),
        serverSeq: 1,
      },
      {
        table: SyncTableName.ChatMessages,
        rowId: 'm2',
        op: 'upsert',
        payloadJson: JSON.stringify({ sender_user_id: 'u1', recipient_user_id: 'u3' }),
        serverSeq: 2,
      },
      {
        table: SyncTableName.ChatMessages,
        rowId: 'm3',
        op: 'upsert',
        payloadJson: JSON.stringify({ sender_user_id: 'u1', recipient_user_id: null }),
        serverSeq: 3,
      },
      {
        table: SyncTableName.ChatReads,
        rowId: 'r1',
        op: 'upsert',
        payloadJson: JSON.stringify({ user_id: 'u1' }),
        serverSeq: 4,
      },
      {
        table: SyncTableName.Entities,
        rowId: 'e1',
        op: 'upsert',
        payloadJson: JSON.stringify({ id: 'e1' }),
        serverSeq: 5,
      },
    ];

    const res = await pullChangesSince(0, { id: 'u2', role: 'user' });
    const ids = res.changes.map((c) => c.row_id);
    expect(ids).toContain('m1');
    expect(ids).toContain('m3');
    expect(ids).toContain('e1');
    expect(ids).not.toContain('m2');
    expect(ids).not.toContain('r1');
  });

  it('applyPushBatch blocks chat update by non-sender', async () => {
    const msgId = '11111111-1111-1111-1111-111111111111';
    const senderId = '22222222-2222-2222-2222-222222222222';
    const actorId = '33333333-3333-3333-3333-333333333333';
    txRowsByTable.set(chatMessages, [{ id: msgId, senderUserId: senderId }]);
    txRowsByTable.set(entityTypes, []);

    const req: SyncPushRequest = {
      client_id: 'c1',
      upserts: [
        {
          table: SyncTableName.ChatMessages,
          rows: [
            {
              id: msgId,
              sender_user_id: actorId,
              sender_username: 'user',
              recipient_user_id: null,
              message_type: 'text',
              body_text: 'hi',
              payload_json: null,
              created_at: 1,
              updated_at: 1,
              deleted_at: null,
              sync_status: 'pending',
            },
          ],
        },
      ],
    };

    await expect(applyPushBatch(req, { id: actorId, username: 'user', role: 'user' })).rejects.toThrow('sync_policy_denied');
  });

  it('applyPushBatch surfaces missing dependency errors', async () => {
    txRowsByTable.set(entityTypes, []);

    const req: SyncPushRequest = {
      client_id: 'c1',
      upserts: [
        {
          table: SyncTableName.Entities,
          rows: [
            {
              id: '44444444-4444-4444-4444-444444444444',
              type_id: '55555555-5555-5555-5555-555555555555',
              created_at: 1,
              updated_at: 1,
              deleted_at: null,
              sync_status: 'pending',
            },
          ],
        },
      ],
    };

    await expect(
      applyPushBatch(req, { id: '66666666-6666-6666-6666-666666666666', username: 'user', role: 'user' }),
    ).rejects.toThrow('sync_dependency_missing');
  });
});
