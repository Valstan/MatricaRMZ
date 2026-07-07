import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

// Regression guard for the prod CPU incident (2026-07-07): user_presence
// heartbeats must NEVER enter the durable, encrypted, fanned-out ledger — they
// otherwise dominate ledger churn and force every client to re-pull/re-decrypt
// constantly. Presence lives only in the userPresence table (online indicator).

const { signAndAppendDetailed, applyPushBatch } = vi.hoisted(() => ({
  signAndAppendDetailed: vi.fn((..._args: any[]) => ({ applied: 0, lastSeq: 0, blockHeight: 0, signed: [] as any[] })),
  applyPushBatch: vi.fn(async () => ({
    applied: 0,
    appliedRows: [],
    idRemaps: { entity_types: {}, attribute_defs: {} },
    skipped: [],
  })),
}));
vi.mock('../ledger/ledgerService.js', () => ({ signAndAppendDetailed }));
vi.mock('../services/sync/applyPushBatch.js', () => ({ applyPushBatch }));

vi.mock('../database/db.js', () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => ({})) })) })),
  },
}));

vi.mock('../services/warehouseLocationsService.js', () => ({
  resolveWarehouseLocationIdsByCodes: vi.fn(async () => new Map()),
}));

import { writeSyncChanges } from '../services/sync/syncWriteService.js';

const presenceInput = {
  type: 'upsert' as const,
  table: SyncTableName.UserPresence,
  row: {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: '11111111-1111-1111-1111-111111111111',
    last_activity_at: 1,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    sync_status: 'synced' as const,
  },
  row_id: '11111111-1111-1111-1111-111111111111',
};

const entityTypeInput = {
  type: 'upsert' as const,
  table: SyncTableName.EntityTypes,
  row: {
    id: '22222222-2222-2222-2222-222222222222',
    code: 'c_test',
    name: 'Test',
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    sync_status: 'synced' as const,
  },
  row_id: '22222222-2222-2222-2222-222222222222',
};

const actor = { id: '99999999-9999-9999-9999-999999999999', username: 'tester', role: 'user' };

describe('user_presence never enters the ledger', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops a presence-only write without touching the ledger', async () => {
    const res = await writeSyncChanges([presenceInput], actor);
    expect(signAndAppendDetailed).not.toHaveBeenCalled();
    expect(applyPushBatch).not.toHaveBeenCalled();
    expect(res.ledgerApplied).toBe(0);
  });

  it('ledgers business rows in a mixed batch but strips presence from the append', async () => {
    await writeSyncChanges([presenceInput, entityTypeInput], actor);
    expect(signAndAppendDetailed).toHaveBeenCalledTimes(1);
    const payloads = (signAndAppendDetailed.mock.calls[0]?.[0] ?? []) as Array<{ table: string }>;
    expect(payloads.every((p) => p.table !== SyncTableName.UserPresence)).toBe(true);
    expect(payloads.some((p) => p.table === SyncTableName.EntityTypes)).toBe(true);
  });
});
