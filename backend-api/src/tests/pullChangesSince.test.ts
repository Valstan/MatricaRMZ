import { beforeEach, describe, expect, it, vi } from 'vitest';

import { entities, ledgerTxIndex } from '../database/schema.js';

const ensureLedgerTxIndexUpToDateMock = vi.fn();
const getLedgerLastSeqMock = vi.fn(() => 0);
const rowsByTable = new Map<unknown, any[][]>();

function dequeueRows(table: unknown) {
  const queue = rowsByTable.get(table);
  if (!queue || queue.length === 0) return [];
  return queue.shift() ?? [];
}

vi.mock('../services/sync/ledgerTxIndexService.js', () => ({
  ensureLedgerTxIndexUpToDate: (...args: any[]) => ensureLedgerTxIndexUpToDateMock(...args),
}));

vi.mock('../ledger/ledgerService.js', () => ({
  getLedgerLastSeq: () => getLedgerLastSeqMock(),
}));

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const chain: any = {
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(async () => dequeueRows(table)),
        };
        return chain;
      }),
    })),
  },
}));

describe('pullChangesSince', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rowsByTable.clear();
    ensureLedgerTxIndexUpToDateMock.mockResolvedValue(undefined);
    getLedgerLastSeqMock.mockReturnValue(0);
    process.env.MATRICA_SYNC_PULL_ADAPTIVE_ENABLED = '0';
  });

  it('sets has_more and server_cursor by page rows', async () => {
    const { pullChangesSince } = await import('../services/sync/pullChangesSince.js');
    rowsByTable.set(ledgerTxIndex, [
      [{ max: 100 }],
      [
        {
          table: 'release_registry',
          rowId: 'r1',
          op: 'upsert',
          payloadJson: JSON.stringify({ id: 'r1' }),
          serverSeq: 21,
        },
      ],
    ]);
    rowsByTable.set(entities, [[
      {
        id: 'e1',
        typeId: 't1',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        syncStatus: 'synced',
        lastServerSeq: 11,
      },
      {
        id: 'e2',
        typeId: 't1',
        createdAt: 2,
        updatedAt: 2,
        deletedAt: null,
        syncStatus: 'synced',
        lastServerSeq: 12,
      },
    ]]);

    const res = await pullChangesSince(0, { id: 'u2', role: 'user' }, 1);
    expect(ensureLedgerTxIndexUpToDateMock).toHaveBeenCalledTimes(1);
    expect(res.server_last_seq).toBe(100);
    expect(res.has_more).toBe(true);
    expect(res.server_cursor).toBeGreaterThan(0);
    expect(res.changes.length).toBe(1);
    expect(res.changes[0]?.row_id).toBe('e1');
  });

  it('adds last_server_seq into payload_json of returned rows', async () => {
    const { pullChangesSince } = await import('../services/sync/pullChangesSince.js');
    rowsByTable.set(ledgerTxIndex, [[{ max: 20 }], []]);
    rowsByTable.set(entities, [[{
      id: 'e1',
      typeId: 't1',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      syncStatus: 'synced',
      lastServerSeq: 7,
    }]]);

    const res = await pullChangesSince(0, { id: 'admin-1', role: 'admin' }, 100);
    expect(res.changes.length).toBe(1);
    const payload = JSON.parse(String(res.changes[0]?.payload_json ?? '{}'));
    expect(payload.last_server_seq).toBe(7);
    expect(payload.id).toBe('e1');
  });
});

