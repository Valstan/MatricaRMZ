import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Table-aware in-memory db mock (same shape as ledgerAuthzGuard.test.ts). `fail`
// makes the next read reject, standing in for a DB outage; `reads` counts the
// queries that actually reached the mock, so throttling is observable.
const state = vi.hoisted(() => ({ selectByTable: new Map<unknown, any[][]>(), fail: false, reads: 0 }));

vi.mock('../../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          state.reads += 1;
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

const { users } = await import('../../database/schema.js');
const { getRestrictedWorkOrderPolicy, __clearRestrictedPolicyCache } = await import('./restrictedWorkOrders.js');

/**
 * Queue one membership read. B3/R2: источник — строгие таблицы, поэтому это одна
 * выборка (users ⋈ user_section_access) вместо двух EAV-запросов. Двойного
 * кодирования JSON, о которое спотыкалась прежняя версия теста, здесь больше нет.
 */
function queueMembershipRead(owner = 'owner1', reader: string | null = 'buh') {
  const rows = [{ userId: 'e1', login: owner, role: 'master', sectionId: 'restricted_work_orders', level: 'editor' }];
  if (reader) {
    rows.push({ userId: 'e2', login: reader, role: 'admin', sectionId: 'restricted_work_orders', level: 'viewer' });
  }
  state.selectByTable.set(users, [rows]);
}

let clock = Date.UTC(2026, 7, 24, 9, 0, 0);
function advance(ms: number) {
  clock += ms;
  vi.setSystemTime(new Date(clock));
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = Date.UTC(2026, 7, 24, 9, 0, 0);
  vi.setSystemTime(new Date(clock));
  state.fail = false;
  state.reads = 0;
  state.selectByTable.clear();
  __clearRestrictedPolicyCache();
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
  // restricted». A failed read must therefore never masquerade as an empty policy.
  it('throws instead of answering «nobody is restricted» when it never read the policy', async () => {
    state.fail = true;
    await expect(getRestrictedWorkOrderPolicy()).rejects.toThrow('db down');
  });

  it('keeps the last policy when a later lookup fails', async () => {
    queueMembershipRead();
    await getRestrictedWorkOrderPolicy();

    advance(60_000); // past the 15 s TTL
    state.fail = true;
    const readsBefore = state.reads;
    const afterOutage = await getRestrictedWorkOrderPolicy();

    expect(state.reads).toBeGreaterThan(readsBefore); // it really tried to re-read
    expect([...afterOutage.owners]).toEqual(['owner1']);
    expect([...afterOutage.readers].sort()).toEqual(['buh', 'owner1']);
  });

  it('after a failure retries within a second; a healthy read holds the full TTL', async () => {
    queueMembershipRead();
    await getRestrictedWorkOrderPolicy();

    // healthy cache: 2 s later nothing reaches the db
    advance(2_000);
    const readsAfterHealthy = state.reads;
    await getRestrictedWorkOrderPolicy();
    expect(state.reads).toBe(readsAfterHealthy);

    // failed read: 2 s later it re-reads and picks up the new policy
    advance(60_000);
    state.fail = true;
    await getRestrictedWorkOrderPolicy();
    advance(2_000);
    state.fail = false;
    queueMembershipRead('owner2', null);
    const refreshed = await getRestrictedWorkOrderPolicy();
    expect([...refreshed.owners]).toEqual(['owner2']);
  });
});
