import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

const signAndAppendDetailedMock = vi.fn();

vi.mock('../ledger/ledgerService.js', () => ({
  signAndAppendDetailed: (...args: any[]) => signAndAppendDetailedMock(...args),
}));

describe('syncChangeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appendLedgerChanges skips rows with invalid payloadJson', async () => {
    const { appendLedgerChanges } = await import('../services/sync/syncChangeService.js');

    const result = appendLedgerChanges(
      { id: 'u1', username: 'user' },
      [{ tableName: SyncTableName.Entities, rowId: 'e1', op: 'upsert', payloadJson: '{bad-json' }],
    );

    expect(result).toEqual({ applied: 0, lastSeq: 0, blockHeight: 0 });
    expect(signAndAppendDetailedMock).not.toHaveBeenCalled();
  });

  it('appendLedgerChanges maps op/table and defaults actor role', async () => {
    signAndAppendDetailedMock.mockReturnValueOnce({ applied: 1, lastSeq: 42, blockHeight: 7, signed: [] });
    const { appendLedgerChanges } = await import('../services/sync/syncChangeService.js');

    const result = appendLedgerChanges(
      { id: 'u1', username: 'operator' },
      [
        {
          tableName: SyncTableName.AttributeValues,
          rowId: 'av1',
          op: 'delete',
          payloadJson: JSON.stringify({ id: 'av1', updated_at: 1000 }),
        },
      ],
    );

    expect(result).toEqual({ applied: 1, lastSeq: 42, blockHeight: 7, signed: [] });
    expect(signAndAppendDetailedMock).toHaveBeenCalledTimes(1);
    const payloads = signAndAppendDetailedMock.mock.calls[0]?.[0];
    expect(Array.isArray(payloads)).toBe(true);
    expect(payloads[0]?.type).toBe('delete');
    expect(payloads[0]?.row_id).toBe('av1');
    expect(payloads[0]?.actor?.userId).toBe('u1');
    expect(payloads[0]?.actor?.username).toBe('operator');
    expect(payloads[0]?.actor?.role).toBe('user');
  });
});

