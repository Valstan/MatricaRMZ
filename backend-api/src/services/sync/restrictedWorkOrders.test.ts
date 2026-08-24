import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Table-aware in-memory db mock (same shape as ledgerAuthzGuard.test.ts); `fail`
// makes the next read reject, standing in for a transient DB outage.
const state = vi.hoisted(() => ({ selectByTable: new Map<unknown, any[][]>(), fail: false }));

vi.mock('../../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          if (state.fail) return Promise.reject(new Error('db down')).then(resolve, reject);
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
  return { db };
});

const { attributeDefs, attributeValues } = await import('../../database/schema.js');
const { getRestrictedWorkOrderPolicy } = await import('./restrictedWorkOrders.js');

/** One membership read: `owner1` is the restricted owner, `buh` the reader. */
function queueMembershipRead() {
  state.selectByTable.set(attributeDefs, [
    [
      { id: 'd-login', code: 'login' },
      { id: 'd-role', code: 'system_role' },
      { id: 'd-sec', code: 'section_access' },
    ],
  ]);
  state.selectByTable.set(attributeValues, [
    [
      { entityId: 'e1', defId: 'd-login', v: JSON.stringify('owner1') },
      { entityId: 'e1', defId: 'd-role', v: JSON.stringify('master') },
      // prod stores the membership double-encoded — parseSectionMembership tolerates it
      { entityId: 'e1', defId: 'd-sec', v: JSON.stringify(JSON.stringify({ restricted_work_orders: 'editor' })) },
      { entityId: 'e2', defId: 'd-login', v: JSON.stringify('buh') },
      { entityId: 'e2', defId: 'd-role', v: JSON.stringify('admin') },
      { entityId: 'e2', defId: 'd-sec', v: JSON.stringify(JSON.stringify({ restricted_work_orders: 'viewer' })) },
    ],
  ]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-24T09:00:00Z'));
  state.fail = false;
  state.selectByTable.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getRestrictedWorkOrderPolicy', () => {
  it('builds owners/readers from the section membership', async () => {
    queueMembershipRead();
    const policy = await getRestrictedWorkOrderPolicy();
    expect([...policy.owners]).toEqual(['owner1']);
    expect([...policy.readers].sort()).toEqual(['buh', 'owner1']);
  });

  // D-041 removed the hardcoded login pair, so «no rows» now means «nobody is
  // restricted». A failed lookup must therefore NOT be read as an empty policy —
  // that would publish a restricted owner's orders to every operator.
  it('keeps the last policy when the lookup fails after the TTL', async () => {
    queueMembershipRead();
    await getRestrictedWorkOrderPolicy();

    vi.setSystemTime(new Date('2026-08-24T09:01:00Z')); // past the 15s TTL
    state.fail = true;
    const afterOutage = await getRestrictedWorkOrderPolicy();
    expect([...afterOutage.owners]).toEqual(['owner1']);
    expect([...afterOutage.readers].sort()).toEqual(['buh', 'owner1']);
  });

  it('retries sooner than a healthy read after a failure', async () => {
    queueMembershipRead();
    await getRestrictedWorkOrderPolicy();
    vi.setSystemTime(new Date('2026-08-24T09:01:00Z'));
    state.fail = true;
    await getRestrictedWorkOrderPolicy();

    // 2 s later a healthy cache would still be serving; the failed one re-reads
    vi.setSystemTime(new Date('2026-08-24T09:01:02Z'));
    state.fail = false;
    state.selectByTable.set(attributeDefs, [
      [
        { id: 'd-login', code: 'login' },
        { id: 'd-role', code: 'system_role' },
        { id: 'd-sec', code: 'section_access' },
      ],
    ]);
    state.selectByTable.set(attributeValues, [
      [
        { entityId: 'e3', defId: 'd-login', v: JSON.stringify('owner2') },
        { entityId: 'e3', defId: 'd-role', v: JSON.stringify('master') },
        { entityId: 'e3', defId: 'd-sec', v: JSON.stringify(JSON.stringify({ restricted_work_orders: 'editor' })) },
      ],
    ]);
    const refreshed = await getRestrictedWorkOrderPolicy();
    expect([...refreshed.owners]).toEqual(['owner2']);
  });
});
