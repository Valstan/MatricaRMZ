import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// POST /changes/:id/apply must run its ledger writes through
// partitionLedgerInputsByAuthz (the single authz point, GOTCHAS M34) — before
// the fix it called writeSyncChanges directly, so a crafted change request with
// an attribute_values row for a server-only employee attr (system_role,
// password_hash, …) would have been applied past every guard.

const { dbResults, writeSyncChanges, partitionLedgerInputsByAuthz, recordLedgerAuthzDenial } = vi.hoisted(() => ({
  // One entry per awaited drizzle chain, in call order.
  dbResults: [] as unknown[],
  writeSyncChanges: vi.fn().mockResolvedValue({ dbApplied: 1, ledgerApplied: 1, lastSeq: 1, blockHeight: 1, appliedRows: [], idRemaps: [], skipped: [] }),
  partitionLedgerInputsByAuthz: vi.fn(),
  recordLedgerAuthzDenial: vi.fn(),
}));

function chainable(): unknown {
  const target = () => undefined;
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          Promise.resolve(dbResults.shift()).then(resolve, reject);
      }
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

vi.mock('../database/db.js', () => ({
  db: {
    select: () => chainable(),
    update: () => chainable(),
    insert: () => chainable(),
    transaction: vi.fn(),
  },
}));

vi.mock('../auth/middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'u-admin', username: 'admin', role: 'admin' };
    next();
  },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/sync/syncWriteService.js', () => ({ writeSyncChanges }));
vi.mock('../services/sync/ledgerAuthzGuard.js', () => ({ partitionLedgerInputsByAuthz }));
vi.mock('../services/authzDenialLog.js', () => ({ recordLedgerAuthzDenial }));

import { changesRouter } from '../routes/changes.js';
import express from 'express';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/changes', changesRouter);
  return app;
}

const CR_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';

const roleAttrRow = {
  id: '44444444-4444-4444-8444-444444444444',
  entity_id: EMPLOYEE_ID,
  attribute_def_id: '55555555-5555-4555-8555-555555555555',
  value_json: '"admin"',
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  sync_status: 'synced',
};

function pendingChangeRequest() {
  return {
    id: CR_ID,
    status: 'pending',
    tableName: 'attribute_values',
    rowId: roleAttrRow.id,
    afterJson: JSON.stringify(roleAttrRow),
    recordOwnerUserId: null,
  };
}

describe('POST /changes/:id/apply — ledger authz backstop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
  });

  it('denied partition → 403, nothing written, denial logged', async () => {
    dbResults.push([pendingChangeRequest()]); // select change_requests
    dbResults.push([]); // select entities (parent touch lookup)
    partitionLedgerInputsByAuthz.mockResolvedValueOnce({
      allowed: [],
      denied: [{ table: 'attribute_values', row_id: roleAttrRow.id, reason: 'forbidden:employee_auth_attr:system_role' }],
    });

    const res = await request(makeApp()).post(`/changes/${CR_ID}/apply`).send({});
    expect(res.status).toBe(403);
    expect(writeSyncChanges).not.toHaveBeenCalled();
    expect(recordLedgerAuthzDenial).toHaveBeenCalledTimes(1);
  });

  it('allowed partition → writes exactly the allowed rows and applies', async () => {
    dbResults.push([pendingChangeRequest()]); // select change_requests
    dbResults.push([]); // select entities (parent touch lookup)
    dbResults.push({}); // update change_requests → applied
    const allowed = [{ type: 'upsert', table: 'attribute_values', row: roleAttrRow, row_id: roleAttrRow.id }];
    partitionLedgerInputsByAuthz.mockResolvedValueOnce({ allowed, denied: [] });

    const res = await request(makeApp()).post(`/changes/${CR_ID}/apply`).send({});
    expect(res.status).toBe(200);
    expect(partitionLedgerInputsByAuthz).toHaveBeenCalledTimes(1);
    expect(writeSyncChanges).toHaveBeenCalledWith(allowed, { id: 'u-admin', username: 'admin', role: 'admin' });
    expect(recordLedgerAuthzDenial).not.toHaveBeenCalled();
  });
});
