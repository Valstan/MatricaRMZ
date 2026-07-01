import { describe, expect, it, vi } from 'vitest';

// The pure helpers are what we test, but the module imports db.js at load — stub it.
vi.mock('../../database/db.js', () => ({ db: {} }));

const {
  classifyWorkOrderAccess,
  isWorkOrderVisible,
  computeWorkOrderPurgeIds,
  isAllowlistedReader,
  canEditRestrictedWorkOrder,
} = await import('./restrictedWorkOrders.js');

// wo1/wo2 owned by ramzia (restricted+confined), wo3 by valstan, wo4 by sapegin.
const OWNERS = new Map<string, string>([
  ['wo1', 'ramzia'],
  ['wo2', 'ramzia'],
  ['wo3', 'valstan'],
  ['wo4', 'sapegin'],
]);

describe('classifyWorkOrderAccess', () => {
  it('superadmin sees all', () => {
    expect(classifyWorkOrderAccess('superadmin', 'valstan', OWNERS)).toEqual({ kind: 'all' });
  });

  it('accountant (glavbux) on the read-allowlist sees all, even as admin', () => {
    expect(classifyWorkOrderAccess('admin', 'glavbux', OWNERS)).toEqual({ kind: 'all' });
  });

  it('confined owner (ramzia) sees only her own work orders', () => {
    const a = classifyWorkOrderAccess('master', 'Ramzia', OWNERS);
    expect(a.kind).toBe('own');
    if (a.kind !== 'own') throw new Error('expected own');
    expect([...a.ownIds].sort()).toEqual(['wo1', 'wo2']);
    expect([...a.allIds].sort()).toEqual(['wo1', 'wo2', 'wo3', 'wo4']);
  });

  it('a plain admin (not on the allowlist) is treated as an ordinary operator', () => {
    const a = classifyWorkOrderAccess('admin', 'someadmin', OWNERS);
    expect(a.kind).toBe('others');
    if (a.kind !== 'others') throw new Error('expected others');
    expect([...a.restrictedIds].sort()).toEqual(['wo1', 'wo2']);
  });

  it('an ordinary operator sees all except restricted', () => {
    const a = classifyWorkOrderAccess('master', 'ozerolove', OWNERS);
    expect(a.kind).toBe('others');
    if (a.kind !== 'others') throw new Error('expected others');
    expect([...a.restrictedIds].sort()).toEqual(['wo1', 'wo2']);
  });
});

describe('isWorkOrderVisible', () => {
  it('all: everything visible', () => {
    expect(isWorkOrderVisible('wo1', { kind: 'all' })).toBe(true);
  });

  it('own: only the owner’s own work orders; other work orders hidden; non-WO rows visible', () => {
    const access = classifyWorkOrderAccess('master', 'ramzia', OWNERS);
    expect(isWorkOrderVisible('wo1', access)).toBe(true); // her own
    expect(isWorkOrderVisible('wo2', access)).toBe(true); // her own
    expect(isWorkOrderVisible('wo3', access)).toBe(false); // someone else's order
    expect(isWorkOrderVisible('defect-123', access)).toBe(true); // not a work order → visible
  });

  it('others: restricted hidden, the rest visible', () => {
    const access = classifyWorkOrderAccess('master', 'ozerolove', OWNERS);
    expect(isWorkOrderVisible('wo1', access)).toBe(false); // Ramzia's
    expect(isWorkOrderVisible('wo3', access)).toBe(true); // normal order
    expect(isWorkOrderVisible('defect-123', access)).toBe(true);
  });
});

describe('computeWorkOrderPurgeIds', () => {
  it('confined owner (ramzia) drops everyone else’s work orders, keeps her own', () => {
    expect(computeWorkOrderPurgeIds('master', 'ramzia', OWNERS).sort()).toEqual(['wo3', 'wo4']);
  });

  it('ordinary operator drops the restricted (Ramzia) orders', () => {
    expect(computeWorkOrderPurgeIds('master', 'ozerolove', OWNERS).sort()).toEqual(['wo1', 'wo2']);
  });

  it('plain admin also drops the restricted orders', () => {
    expect(computeWorkOrderPurgeIds('admin', 'someadmin', OWNERS).sort()).toEqual(['wo1', 'wo2']);
  });

  it('accountant and superadmin drop nothing', () => {
    expect(computeWorkOrderPurgeIds('admin', 'glavbux', OWNERS)).toEqual([]);
    expect(computeWorkOrderPurgeIds('superadmin', 'valstan', OWNERS)).toEqual([]);
  });
});

describe('canEditRestrictedWorkOrder', () => {
  it('the owner and the superadmin may edit; accountant and others may not', () => {
    expect(canEditRestrictedWorkOrder('master', 'ramzia', 'ramzia')).toBe(true);
    expect(canEditRestrictedWorkOrder('master', '  Ramzia ', 'ramzia')).toBe(true);
    expect(canEditRestrictedWorkOrder('superadmin', 'valstan', 'ramzia')).toBe(true);
    expect(canEditRestrictedWorkOrder('admin', 'glavbux', 'ramzia')).toBe(false);
    expect(canEditRestrictedWorkOrder('master', 'ozerolove', 'ramzia')).toBe(false);
  });
});

describe('isAllowlistedReader', () => {
  it('owner and accountant are allowlisted; others are not', () => {
    expect(isAllowlistedReader('ramzia')).toBe(true);
    expect(isAllowlistedReader('  Glavbux ')).toBe(true);
    expect(isAllowlistedReader('ozerolove')).toBe(false);
    expect(isAllowlistedReader('')).toBe(false);
  });
});
