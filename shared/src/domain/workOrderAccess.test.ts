import { describe, expect, it } from 'vitest';

import {
  EMPTY_RESTRICTED_WORK_ORDER_POLICY,
  canEditWorkOrder,
  canViewWorkOrder,
  restrictedWorkOrderPolicyFromMemberships,
} from './workOrderAccess.js';

// Fictional logins only (D-041 — a public repo carries no employee logins):
// `owner1` is the restricted owner (private + confined), `buh` the accountant
// (read-only), `oper` an ordinary operator, `boss` the superadmin.
const policy = restrictedWorkOrderPolicyFromMemberships([
  { login: 'owner1', level: 'editor' },
  { login: 'buh', level: 'viewer' },
])!;

describe('canViewWorkOrder', () => {
  it('superadmin sees every work order', () => {
    expect(canViewWorkOrder({ viewerLogin: 'boss', viewerRole: 'superadmin', ownerLogin: 'owner1', policy })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: 'boss', viewerRole: 'superadmin', ownerLogin: 'oper', policy })).toBe(true);
  });

  it('the accountant sees every work order, even as plain admin', () => {
    expect(canViewWorkOrder({ viewerLogin: 'buh', viewerRole: 'admin', ownerLogin: 'owner1', policy })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: 'buh', viewerRole: 'admin', ownerLogin: 'oper', policy })).toBe(true);
  });

  it('the restricted owner sees only their own work orders', () => {
    expect(canViewWorkOrder({ viewerLogin: 'owner1', viewerRole: 'master', ownerLogin: 'owner1', policy })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: '  Owner1 ', viewerRole: 'master', ownerLogin: 'OWNER1', policy })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: 'owner1', viewerRole: 'master', ownerLogin: 'oper', policy })).toBe(false);
    expect(canViewWorkOrder({ viewerLogin: 'owner1', viewerRole: 'master', ownerLogin: 'boss', policy })).toBe(false);
  });

  it('an ordinary operator sees all orders except a restricted owner’s', () => {
    expect(canViewWorkOrder({ viewerLogin: 'oper', viewerRole: 'master', ownerLogin: 'oper2', policy })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: 'oper', viewerRole: 'master', ownerLogin: 'owner1', policy })).toBe(false);
  });

  it('a plain admin (not the accountant) also does not see the restricted owner’s orders', () => {
    expect(canViewWorkOrder({ viewerLogin: 'someadmin', viewerRole: 'admin', ownerLogin: 'owner1', policy })).toBe(false);
    expect(canViewWorkOrder({ viewerLogin: 'someadmin', viewerRole: 'admin', ownerLogin: 'oper', policy })).toBe(true);
  });

  it('signed-out / empty viewer does not see the restricted owner’s orders', () => {
    expect(canViewWorkOrder({ viewerLogin: '', viewerRole: '', ownerLogin: 'owner1', policy })).toBe(false);
    expect(canViewWorkOrder({ viewerLogin: '', viewerRole: '', ownerLogin: 'oper', policy })).toBe(true);
  });
});

describe('canEditWorkOrder', () => {
  it('only the owner or superadmin may edit a restricted order; accountant/others may not', () => {
    expect(canEditWorkOrder({ editorLogin: 'owner1', editorRole: 'master', ownerLogin: 'owner1', policy })).toBe(true);
    expect(canEditWorkOrder({ editorLogin: 'boss', editorRole: 'superadmin', ownerLogin: 'owner1', policy })).toBe(true);
    expect(canEditWorkOrder({ editorLogin: 'buh', editorRole: 'admin', ownerLogin: 'owner1', policy })).toBe(false);
    expect(canEditWorkOrder({ editorLogin: 'oper', editorRole: 'master', ownerLogin: 'owner1', policy })).toBe(false);
  });

  it('a non-restricted order is not blocked by this policy (normal RBAC applies elsewhere)', () => {
    expect(canEditWorkOrder({ editorLogin: 'oper', editorRole: 'master', ownerLogin: 'oper2', policy })).toBe(true);
  });
});

// D-041: the module itself holds no logins — the fallback restricts nobody, and a
// caller that must not fail open keeps the last policy it read (server: restrictedWorkOrders.ts).
describe('EMPTY_RESTRICTED_WORK_ORDER_POLICY', () => {
  it('carries no logins, so nothing is restricted without membership rows', () => {
    expect([...EMPTY_RESTRICTED_WORK_ORDER_POLICY.owners]).toEqual([]);
    expect([...EMPTY_RESTRICTED_WORK_ORDER_POLICY.readers]).toEqual([]);
  });

  it('is the default when no policy is passed', () => {
    expect(canViewWorkOrder({ viewerLogin: 'oper', viewerRole: 'master', ownerLogin: 'owner1' })).toBe(true);
    expect(canEditWorkOrder({ editorLogin: 'oper', editorRole: 'master', ownerLogin: 'owner1' })).toBe(true);
  });
});

// Ф3: configurable lists via restricted_work_orders section membership.
describe('restrictedWorkOrderPolicyFromMemberships', () => {
  it('editor = owner (also reader), viewer = reader only', () => {
    const p = restrictedWorkOrderPolicyFromMemberships([
      { login: 'Olga', level: 'editor' },
      { login: 'buh2', level: 'viewer' },
      { login: 'nobody', level: null },
    ]);
    expect(p).not.toBeNull();
    expect([...p!.owners]).toEqual(['olga']);
    expect([...p!.readers].sort()).toEqual(['buh2', 'olga']);
  });

  it('returns null when no row carries the section (caller falls back to the empty policy)', () => {
    expect(restrictedWorkOrderPolicyFromMemberships([{ login: 'x', level: null }])).toBeNull();
    expect(restrictedWorkOrderPolicyFromMemberships([])).toBeNull();
  });

  // Incident 2026-07-28: the owner ticked himself editor of «Наряды закрытые» thinking it
  // widened access; it made his own 54 orders invisible to every operator, and the
  // superadmin bypass in canViewWorkOrder hid that from him.
  it('ignores superadmin rows — his membership grants nothing but could hide his orders', () => {
    const p = restrictedWorkOrderPolicyFromMemberships([
      { login: 'boss', role: 'superadmin', level: 'editor' },
      { login: 'olga', role: 'master', level: 'editor' },
    ]);
    expect([...p!.owners]).toEqual(['olga']);
    expect([...p!.readers]).toEqual(['olga']);
    // orders created under the superadmin's login stay visible to ordinary operators
    expect(canViewWorkOrder({ viewerLogin: 'oper', viewerRole: 'admin', ownerLogin: 'boss', policy: p! })).toBe(true);
    expect(canEditWorkOrder({ editorLogin: 'oper', editorRole: 'admin', ownerLogin: 'boss', policy: p! })).toBe(true);
  });

  it('a superadmin-only membership invents no policy', () => {
    expect(restrictedWorkOrderPolicyFromMemberships([{ login: 'boss', role: 'superadmin', level: 'editor' }])).toBeNull();
  });
});

describe('policy-driven canView/canEdit (Ф3)', () => {
  const p = restrictedWorkOrderPolicyFromMemberships([
    { login: 'olga', level: 'editor' },
    { login: 'buh2', level: 'viewer' },
  ])!;

  it('membership decides who is confined; anyone outside it is ordinary', () => {
    expect(canViewWorkOrder({ viewerLogin: 'olga', viewerRole: 'master', ownerLogin: 'oper', policy: p })).toBe(false);
    expect(canViewWorkOrder({ viewerLogin: 'olga', viewerRole: 'master', ownerLogin: 'olga', policy: p })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: 'oper', viewerRole: 'master', ownerLogin: 'olga', policy: p })).toBe(false);
    // owner1 is NOT in this policy → their orders are ordinary here
    expect(canViewWorkOrder({ viewerLogin: 'oper', viewerRole: 'master', ownerLogin: 'owner1', policy: p })).toBe(true);
  });

  it('viewer-level member reads all, cannot edit the owner’s orders', () => {
    expect(canViewWorkOrder({ viewerLogin: 'buh2', viewerRole: 'admin', ownerLogin: 'olga', policy: p })).toBe(true);
    expect(canEditWorkOrder({ editorLogin: 'buh2', editorRole: 'admin', ownerLogin: 'olga', policy: p })).toBe(false);
    expect(canEditWorkOrder({ editorLogin: 'olga', editorRole: 'master', ownerLogin: 'olga', policy: p })).toBe(true);
  });
});
