import { describe, expect, it, vi } from 'vitest';

// isRestrictedWorkOrderVisible is pure, but the module imports db.js at load — stub it.
vi.mock('../../database/db.js', () => ({ db: {} }));

const { isRestrictedWorkOrderVisible, isAllowlistedReader } = await import('./restrictedWorkOrders.js');

const RESTRICTED = 'op-ramzia-1';
const ORDINARY = 'op-other-1';
const restrictedIds = new Set([RESTRICTED]);

describe('isRestrictedWorkOrderVisible', () => {
  it('non-restricted order is visible to everyone (incl. plain operator)', () => {
    expect(
      isRestrictedWorkOrderVisible(ORDINARY, { restrictedIds, actorIsAdmin: false, actorIsAllowlisted: false }),
    ).toBe(true);
  });

  it('restricted order is hidden from a non-admin, non-allowlisted operator', () => {
    expect(
      isRestrictedWorkOrderVisible(RESTRICTED, { restrictedIds, actorIsAdmin: false, actorIsAllowlisted: false }),
    ).toBe(false);
  });

  it('restricted order is visible to an allowlisted reader (owner / accountant)', () => {
    expect(
      isRestrictedWorkOrderVisible(RESTRICTED, { restrictedIds, actorIsAdmin: false, actorIsAllowlisted: true }),
    ).toBe(true);
  });

  it('restricted order is visible to an admin / superadmin', () => {
    expect(
      isRestrictedWorkOrderVisible(RESTRICTED, { restrictedIds, actorIsAdmin: true, actorIsAllowlisted: false }),
    ).toBe(true);
  });

  it('with no restricted ids, every order is visible', () => {
    const empty = new Set<string>();
    expect(
      isRestrictedWorkOrderVisible(RESTRICTED, { restrictedIds: empty, actorIsAdmin: false, actorIsAllowlisted: false }),
    ).toBe(true);
  });
});

describe('isAllowlistedReader', () => {
  it('owner (ramzia) and accountant (glavbux) are allowlisted', () => {
    expect(isAllowlistedReader('ramzia')).toBe(true);
    expect(isAllowlistedReader('glavbux')).toBe(true);
  });

  it('is case- and whitespace-insensitive on the login', () => {
    expect(isAllowlistedReader('  Ramzia ')).toBe(true);
  });

  it('a plain operator and an empty login are not allowlisted', () => {
    expect(isAllowlistedReader('ozerolove')).toBe(false);
    expect(isAllowlistedReader('')).toBe(false);
  });
});
