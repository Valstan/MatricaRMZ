import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName, type SyncPushRequest } from '@matricarmz/shared';

import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { pullChangesSince } from '../services/sync/pullChangesSince.js';
import { chatMessages, entities, entityTypes } from '../database/schema.js';
import { makeInsertChain, makeTxSelectFromTableMap } from './utils/dbMockHelpers.js';

const selectQueue: any[] = [];
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

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(function () {
          return this;
        }),
        orderBy: vi.fn(function () {
          return this;
        }),
        limit: vi.fn(async () => (selectQueue.length > 0 ? (selectQueue.shift() as any[]) : [])),
      })),
    })),
    transaction: vi.fn(async (cb: any) => cb(txMock)),
  },
}));

describe('sync privacy and errors', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    txRowsByTable = new Map();
    vi.clearAllMocks();
    txMock.select.mockImplementation(makeTxSelectFromTableMap(txRowsByTable));
    process.env.MATRICA_SYNC_PULL_ADAPTIVE_ENABLED = '0';
    process.env.MATRICA_SYNC_STRICT_DEPENDENCIES = '1';
  });

  it('pullChangesSince keeps chat privacy for non-admin', async () => {
    selectQueue.push(
      [{ max: 5 }],
      [{ count: 0 }],
      [],
      [],
      [
        {
          id: 'e1',
          typeId: 't1',
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          syncStatus: 'synced',
          lastServerSeq: 5,
        },
      ],
      [],
      [],
      [],
      [
        {
          id: 'm1',
          senderUserId: 'u1',
          senderUsername: 'u1',
          recipientUserId: 'u2',
          messageType: 'text',
          bodyText: 'hello',
          payloadJson: null,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          syncStatus: 'synced',
          lastServerSeq: 1,
        },
      ],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    );

    const res = await pullChangesSince(0, { id: 'u2', role: 'user' });
    const ids = res.changes.map((c) => c.row_id);
    expect(ids).toContain('m1');
    expect(ids).toContain('e1');
  });

  it('pullChangesSince returns all chat rows for admin', async () => {
    selectQueue.push(
      [{ max: 2 }],
      [{ count: 0 }],
      [],
      [],
      [],
      [],
      [],
      [],
      [
        {
          id: 'm1',
          senderUserId: 'u1',
          senderUsername: 'u1',
          recipientUserId: 'u2',
          messageType: 'text',
          bodyText: 'one',
          payloadJson: null,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          syncStatus: 'synced',
          lastServerSeq: 1,
        },
        {
          id: 'm2',
          senderUserId: 'u1',
          senderUsername: 'u1',
          recipientUserId: null,
          messageType: 'text',
          bodyText: 'two',
          payloadJson: null,
          createdAt: 2,
          updatedAt: 2,
          deletedAt: null,
          syncStatus: 'synced',
          lastServerSeq: 2,
        },
      ],
      [],
      [],
      [],
      [],
      [],
    );
    const res = await pullChangesSince(0, { id: 'admin-1', role: 'admin' });
    const ids = res.changes.map((c) => c.row_id);
    expect(ids).toContain('m1');
    expect(ids).toContain('m2');
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

  it('applyPushBatch allows chat update by sender', async () => {
    const msgId = '11111111-1111-1111-1111-111111111111';
    const senderId = '22222222-2222-2222-2222-222222222222';
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
              sender_user_id: senderId,
              sender_username: 'sender',
              recipient_user_id: null,
              message_type: 'text',
              body_text: 'updated',
              payload_json: null,
              created_at: 1,
              updated_at: 2,
              deleted_at: null,
              sync_status: 'pending',
            },
          ],
        },
      ],
    };

    const r = await applyPushBatch(req, { id: senderId, username: 'sender', role: 'user' });
    expect(r.applied).toBeGreaterThan(0);
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

  it('applyPushBatch rejects seq-less undelete over tombstone with known server seq', async () => {
    txRowsByTable.set(entityTypes, [{ id: '11111111-1111-1111-1111-111111111111' }]);
    txRowsByTable.set(entities, [
      {
        id: '22222222-2222-2222-2222-222222222222',
        typeId: '11111111-1111-1111-1111-111111111111',
        updatedAt: 1000,
        deletedAt: 900,
        lastServerSeq: 10,
      },
    ]);

    const req: SyncPushRequest = {
      client_id: 'c1',
      upserts: [
        {
          table: SyncTableName.Entities,
          rows: [
            {
              id: '22222222-2222-2222-2222-222222222222',
              type_id: '11111111-1111-1111-1111-111111111111',
              created_at: 1,
              updated_at: 1200,
              deleted_at: null,
              sync_status: 'pending',
            },
          ],
        },
      ],
    };

    await expect(applyPushBatch(req, { id: 'u1', username: 'user', role: 'user' })).rejects.toThrow('sync_conflict');
  });

  it('applyPushBatch accepts update with newer last_server_seq', async () => {
    txRowsByTable.set(entityTypes, [{ id: '11111111-1111-1111-1111-111111111111' }]);
    txRowsByTable.set(entities, [
      {
        id: '22222222-2222-2222-2222-222222222222',
        typeId: '11111111-1111-1111-1111-111111111111',
        updatedAt: 1000,
        deletedAt: null,
        lastServerSeq: 10,
      },
    ]);

    const req: SyncPushRequest = {
      client_id: 'c1',
      upserts: [
        {
          table: SyncTableName.Entities,
          rows: [
            {
              id: '22222222-2222-2222-2222-222222222222',
              type_id: '11111111-1111-1111-1111-111111111111',
              created_at: 1,
              updated_at: 900,
              deleted_at: null,
              last_server_seq: 11,
              sync_status: 'pending',
            },
          ],
        },
      ],
    };

    const r = await applyPushBatch(req, { id: 'u1', username: 'user', role: 'user' });
    expect(r.applied).toBeGreaterThan(0);
  });

  it.each([
    {
      name: 'rejects when incoming last_server_seq is older',
      existing: { updatedAt: 1000, deletedAt: null, lastServerSeq: 20 },
      incoming: { updated_at: 2000, deleted_at: null, last_server_seq: 10 },
      shouldReject: true,
    },
    {
      name: 'accepts when incoming last_server_seq is equal',
      existing: { updatedAt: 1000, deletedAt: null, lastServerSeq: 20 },
      incoming: { updated_at: 900, deleted_at: null, last_server_seq: 20 },
      shouldReject: false,
    },
    {
      name: 'accepts seq-less delete over non-deleted row',
      existing: { updatedAt: 1000, deletedAt: null, lastServerSeq: 20 },
      incoming: { updated_at: 900, deleted_at: 1200 },
      shouldReject: false,
    },
  ])('applyPushBatch conflict matrix: $name', async ({ existing, incoming, shouldReject }) => {
    txRowsByTable.set(entityTypes, [{ id: '11111111-1111-1111-1111-111111111111' }]);
    txRowsByTable.set(entities, [
      {
        id: '22222222-2222-2222-2222-222222222222',
        typeId: '11111111-1111-1111-1111-111111111111',
        ...existing,
      },
    ]);

    const req: SyncPushRequest = {
      client_id: 'c1',
      upserts: [
        {
          table: SyncTableName.Entities,
          rows: [
            {
              id: '22222222-2222-2222-2222-222222222222',
              type_id: '11111111-1111-1111-1111-111111111111',
              created_at: 1,
              sync_status: 'pending',
              ...incoming,
            },
          ],
        },
      ],
    };

    if (shouldReject) {
      await expect(applyPushBatch(req, { id: 'u1', username: 'user', role: 'user' })).rejects.toThrow('sync_conflict');
      return;
    }
    const result = await applyPushBatch(req, { id: 'u1', username: 'user', role: 'user' });
    expect(result.applied).toBeGreaterThan(0);
  });
});
