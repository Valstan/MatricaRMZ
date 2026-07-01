import { describe, expect, it, vi } from 'vitest';

// isRestrictedWorkOrderVisible / canRead / canEdit are pure, but the module imports db.js at load — stub it.
vi.mock('../../database/db.js', () => ({ db: {} }));

const {
  isRestrictedWorkOrderVisible,
  isAllowlistedReader,
  canReadRestrictedWorkOrders,
  canEditRestrictedWorkOrder,
} = await import('./restrictedWorkOrders.js');

const RESTRICTED = 'op-ramzia-1';
const ORDINARY = 'op-other-1';
const restrictedIds = new Set([RESTRICTED]);

describe('isRestrictedWorkOrderVisible', () => {
  it('non-restricted order is visible to everyone (incl. plain operator)', () => {
    expect(isRestrictedWorkOrderVisible(ORDINARY, { restrictedIds, actorCanRead: false })).toBe(true);
  });

  it('restricted order is hidden from an actor who may not read it', () => {
    expect(isRestrictedWorkOrderVisible(RESTRICTED, { restrictedIds, actorCanRead: false })).toBe(false);
  });

  it('restricted order is visible to an actor who may read it', () => {
    expect(isRestrictedWorkOrderVisible(RESTRICTED, { restrictedIds, actorCanRead: true })).toBe(true);
  });

  it('with no restricted ids, every order is visible', () => {
    const empty = new Set<string>();
    expect(isRestrictedWorkOrderVisible(RESTRICTED, { restrictedIds: empty, actorCanRead: false })).toBe(true);
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

describe('canReadRestrictedWorkOrders', () => {
  it('superadmin may read', () => {
    expect(canReadRestrictedWorkOrders('superadmin', 'valstan')).toBe(true);
  });

  it('owner (ramzia) and accountant (glavbux) may read regardless of role', () => {
    expect(canReadRestrictedWorkOrders('master', 'ramzia')).toBe(true);
    expect(canReadRestrictedWorkOrders('admin', 'glavbux')).toBe(true);
  });

  it('a plain admin (not on the allowlist) may NOT read', () => {
    expect(canReadRestrictedWorkOrders('admin', 'someadmin')).toBe(false);
  });

  it('a plain operator and legacy user may NOT read', () => {
    expect(canReadRestrictedWorkOrders('master', 'ozerolove')).toBe(false);
    expect(canReadRestrictedWorkOrders('user', 'mubvera')).toBe(false);
  });
});

describe('canEditRestrictedWorkOrder', () => {
  const OWNER = 'ramzia';

  it('the owner may edit their own restricted order', () => {
    expect(canEditRestrictedWorkOrder('master', 'ramzia', OWNER)).toBe(true);
    expect(canEditRestrictedWorkOrder('master', '  Ramzia ', OWNER)).toBe(true);
  });

  it('the superadmin may edit', () => {
    expect(canEditRestrictedWorkOrder('superadmin', 'valstan', OWNER)).toBe(true);
  });

  it('the accountant (read-allowlist) may NOT edit', () => {
    expect(canEditRestrictedWorkOrder('admin', 'glavbux', OWNER)).toBe(false);
  });

  it('a plain admin and other operators may NOT edit', () => {
    expect(canEditRestrictedWorkOrder('admin', 'someadmin', OWNER)).toBe(false);
    expect(canEditRestrictedWorkOrder('master', 'ozerolove', OWNER)).toBe(false);
  });
});
