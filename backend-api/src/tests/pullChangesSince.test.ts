import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeQueuedSelectMock } from './utils/dbMockHelpers.js';

const ensureLedgerTxIndexUpToDateMock = vi.fn();
const selectQueue: any[] = [];

vi.mock('../services/sync/ledgerTxIndexService.js', () => ({
  ensureLedgerTxIndexUpToDate: (...args: any[]) => ensureLedgerTxIndexUpToDateMock(...args),
}));

vi.mock('../database/db.js', () => ({
  db: {
    select: makeQueuedSelectMock(selectQueue),
  },
}));

describe('pullChangesSince', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    ensureLedgerTxIndexUpToDateMock.mockResolvedValue(undefined);
    process.env.MATRICA_SYNC_PULL_ADAPTIVE_ENABLED = '0';
  });

  it('sets has_more/server_cursor by page rows and filters chat payload by actor', async () => {
    const { pullChangesSince } = await import('../services/sync/pullChangesSince.js');
    selectQueue.push(
      [{ max: 100 }],
      [
        {
          table: 'chat_messages',
          rowId: 'm-hidden',
          op: 'upsert',
          payloadJson: JSON.stringify({ sender_user_id: 'u1', recipient_user_id: 'u3' }),
          serverSeq: 11,
        },
        {
          table: 'entities',
          rowId: 'e-visible',
          op: 'upsert',
          payloadJson: JSON.stringify({ id: 'e-visible' }),
          serverSeq: 12,
        },
      ],
    );

    const res = await pullChangesSince(0, { id: 'u2', role: 'user' }, 1);
    expect(ensureLedgerTxIndexUpToDateMock).toHaveBeenCalledTimes(1);
    expect(res.server_last_seq).toBe(100);
    expect(res.has_more).toBe(true);
    expect(res.server_cursor).toBe(11);
    expect(res.changes).toEqual([]);
  });

  it('adds last_server_seq into payload_json of returned rows', async () => {
    const { pullChangesSince } = await import('../services/sync/pullChangesSince.js');
    selectQueue.push(
      [{ max: 20 }],
      [
        {
          table: 'entities',
          rowId: 'e1',
          op: 'upsert',
          payloadJson: JSON.stringify({ id: 'e1' }),
          serverSeq: 7,
        },
      ],
    );

    const res = await pullChangesSince(0, { id: 'admin-1', role: 'admin' }, 100);
    expect(res.changes.length).toBe(1);
    const payload = JSON.parse(String(res.changes[0]?.payload_json ?? '{}'));
    expect(payload.last_server_seq).toBe(7);
    expect(payload.id).toBe('e1');
  });
});

