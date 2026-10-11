import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

// M102: heartbeat push'а (`sync_state.last_pushed_at`) обязан идти по id машины,
// а не аккаунта — иначе у машин колонка пуста, а «аккаунты» выглядят
// машинами-призраками, которые только пушат.

const { applyPushBatch } = vi.hoisted(() => ({
  applyPushBatch: vi.fn(async () => ({
    applied: 0,
    appliedRows: [],
    idRemaps: { entity_types: {}, attribute_defs: {} },
    skipped: [],
  })),
}));
vi.mock('../ledger/ledgerService.js', () => ({
  signAndAppendDetailed: vi.fn((..._args: any[]) => ({ applied: 0, lastSeq: 0, blockHeight: 0, signed: [] as any[] })),
}));
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

function pushClientId(): string | null {
  const calls = (applyPushBatch as any).mock?.calls ?? [];
  if (calls.length === 0) return null;
  return String(calls[0]?.[0]?.client_id ?? '');
}

describe('push heartbeat идёт по id машины', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clientId из тела push становится client_id батча', async () => {
    await writeSyncChanges([entityTypeInput], {
      id: '99999999-9999-9999-9999-999999999999',
      username: 'tester',
      role: 'user',
      clientId: 'PC99-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(pushClientId()).toBe('PC99-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('без clientId (старые сборки, серверные писатели) — откат на id аккаунта', async () => {
    await writeSyncChanges([entityTypeInput], {
      id: '99999999-9999-9999-9999-999999999999',
      username: 'tester',
      role: 'user',
    });
    expect(pushClientId()).toBe('99999999-9999-9999-9999-999999999999');
  });
});
