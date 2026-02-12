import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

const queryStateMock = vi.fn();
const getLedgerLastSeqMock = vi.fn();

vi.mock('../ledger/ledgerService.js', () => ({
  queryState: (...args: any[]) => queryStateMock(...args),
  getLedgerLastSeq: (...args: any[]) => getLedgerLastSeqMock(...args),
}));

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

function pagedRows(rows: Array<Record<string, unknown>>, opts?: { cursorValue?: string | number; limit?: number }) {
  const cursor = opts?.cursorValue == null ? null : String(opts.cursorValue);
  const limit = Math.max(1, Number(opts?.limit ?? 5000));
  const filtered = cursor == null ? rows : rows.filter((r) => String(r.id ?? '') > cursor);
  return filtered.slice(0, limit);
}

describe('diagnostics consistency snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MATRICA_DIAGNOSTICS_LEDGER_PAGE_SIZE = '2';
  });

  it('computes server snapshot with pending/error items and paged ledger reads', async () => {
    getLedgerLastSeqMock.mockReturnValue(12345);
    const manyEntities = Array.from({ length: 510 }, (_, i) => ({
      id: `e-${String(i + 10).padStart(4, '0')}`,
      type_id: 'et-1',
      updated_at: 4000 + i,
      sync_status: 'synced',
    }));

    const byTable = new Map<string, Array<Record<string, unknown>>>([
      [
        SyncTableName.EntityTypes,
        [{ id: 'et-1', code: 'engine', updated_at: 100, sync_status: 'synced' }],
      ],
      [
        SyncTableName.AttributeDefs,
        [{ id: 'ad-1', entity_type_id: 'et-1', code: 'name', updated_at: 110, sync_status: 'synced' }],
      ],
      [
        SyncTableName.Entities,
        [
          { id: 'e-0001', type_id: 'et-1', updated_at: 1000, sync_status: 'pending' },
          { id: 'e-0002', type_id: 'et-1', updated_at: 3000, sync_status: 'error' },
          { id: 'e-0003', type_id: 'et-1', updated_at: 2000, sync_status: 'synced' },
          ...manyEntities,
        ],
      ],
      [
        SyncTableName.AttributeValues,
        [
          {
            id: 'av-1',
            entity_id: 'e-0001',
            attribute_def_id: 'ad-1',
            value_json: JSON.stringify('Engine A'),
            updated_at: 1000,
            sync_status: 'synced',
          },
          {
            id: 'av-2',
            entity_id: 'e-0002',
            attribute_def_id: 'ad-1',
            value_json: JSON.stringify('Engine B'),
            updated_at: 3000,
            sync_status: 'synced',
          },
        ],
      ],
    ]);

    queryStateMock.mockImplementation((table: string, opts?: { cursorValue?: string | number; limit?: number }) => {
      const rows = byTable.get(String(table)) ?? [];
      return pagedRows(rows, opts);
    });

    const { computeServerSnapshot } = await import('../services/diagnosticsConsistencyService.js');
    const snapshot = await computeServerSnapshot();

    expect(snapshot.source).toBe('ledger');
    expect(snapshot.serverSeq).toBe(12345);
    expect(snapshot.tables.entities?.count).toBe(513);
    expect(snapshot.entityTypes.engine?.count).toBe(513);
    expect(snapshot.entityTypes.engine?.pendingCount).toBe(1);
    expect(snapshot.entityTypes.engine?.errorCount).toBe(1);
    const engineSnapshot = snapshot.entityTypes.engine as any;
    expect(engineSnapshot?.pendingItems?.[0]?.id).toBe('e-0002');
    expect(engineSnapshot?.pendingItems?.[0]?.label).toBe('Engine B');
    expect(engineSnapshot?.pendingItems?.[1]?.id).toBe('e-0001');
    expect(engineSnapshot?.pendingItems?.[1]?.label).toBe('Engine A');

    const hasPagedRead = queryStateMock.mock.calls.some(
      (call) => String(call[0]) === SyncTableName.Entities && call[1]?.cursorValue != null,
    );
    expect(hasPagedRead).toBe(true);
  });

  it('returns degraded snapshot when ledger read throws', async () => {
    getLedgerLastSeqMock.mockReturnValue(1);
    queryStateMock.mockImplementation(() => {
      throw new Error('ledger unavailable');
    });

    const { computeServerSnapshot } = await import('../services/diagnosticsConsistencyService.js');
    const snapshot = await computeServerSnapshot();

    expect(snapshot.source).toBe('unknown');
    expect(snapshot.serverSeq).toBeNull();
    expect(snapshot.degradedReason).toContain('ledger unavailable');
    expect(snapshot.tables).toEqual({});
    expect(snapshot.entityTypes).toEqual({});
  });
});

