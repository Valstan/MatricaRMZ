import { describe, expect, it } from 'vitest';

import { canEditWorkOrder, canViewWorkOrder } from './workOrderAccess.js';

// ramzia is the restricted (private + confined) owner; glavbux the accountant (reader).
describe('canViewWorkOrder', () => {
  it('superadmin sees every work order', () => {
    expect(canViewWorkOrder({ viewerLogin: 'valstan', viewerRole: 'superadmin', ownerLogin: 'ramzia' })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: 'valstan', viewerRole: 'superadmin', ownerLogin: 'sapegin' })).toBe(true);
  });

  it('accountant (glavbux) sees every work order, even as plain admin', () => {
    expect(canViewWorkOrder({ viewerLogin: 'glavbux', viewerRole: 'admin', ownerLogin: 'ramzia' })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: 'glavbux', viewerRole: 'admin', ownerLogin: 'sapegin' })).toBe(true);
  });

  it('the restricted owner (ramzia) sees only her own work orders', () => {
    expect(canViewWorkOrder({ viewerLogin: 'ramzia', viewerRole: 'master', ownerLogin: 'ramzia' })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: '  Ramzia ', viewerRole: 'master', ownerLogin: 'RAMZIA' })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: 'ramzia', viewerRole: 'master', ownerLogin: 'sapegin' })).toBe(false);
    expect(canViewWorkOrder({ viewerLogin: 'ramzia', viewerRole: 'master', ownerLogin: 'valstan' })).toBe(false);
  });

  it('an ordinary operator sees all orders except a restricted owner’s', () => {
    expect(canViewWorkOrder({ viewerLogin: 'ozerolove', viewerRole: 'master', ownerLogin: 'sapegin' })).toBe(true);
    expect(canViewWorkOrder({ viewerLogin: 'ozerolove', viewerRole: 'master', ownerLogin: 'ramzia' })).toBe(false);
  });

  it('a plain admin (not the accountant) also does not see the restricted owner’s orders', () => {
    expect(canViewWorkOrder({ viewerLogin: 'someadmin', viewerRole: 'admin', ownerLogin: 'ramzia' })).toBe(false);
    expect(canViewWorkOrder({ viewerLogin: 'someadmin', viewerRole: 'admin', ownerLogin: 'sapegin' })).toBe(true);
  });

  it('signed-out / empty viewer does not see the restricted owner’s orders', () => {
    expect(canViewWorkOrder({ viewerLogin: '', viewerRole: '', ownerLogin: 'ramzia' })).toBe(false);
    expect(canViewWorkOrder({ viewerLogin: '', viewerRole: '', ownerLogin: 'sapegin' })).toBe(true);
  });
});

describe('canEditWorkOrder', () => {
  it('only the owner or superadmin may edit a restricted order; accountant/others may not', () => {
    expect(canEditWorkOrder({ editorLogin: 'ramzia', editorRole: 'master', ownerLogin: 'ramzia' })).toBe(true);
    expect(canEditWorkOrder({ editorLogin: 'valstan', editorRole: 'superadmin', ownerLogin: 'ramzia' })).toBe(true);
    expect(canEditWorkOrder({ editorLogin: 'glavbux', editorRole: 'admin', ownerLogin: 'ramzia' })).toBe(false);
    expect(canEditWorkOrder({ editorLogin: 'ozerolove', editorRole: 'master', ownerLogin: 'ramzia' })).toBe(false);
  });

  it('a non-restricted order is not blocked by this policy (normal RBAC applies elsewhere)', () => {
    expect(canEditWorkOrder({ editorLogin: 'ozerolove', editorRole: 'master', ownerLogin: 'sapegin' })).toBe(true);
  });
});
