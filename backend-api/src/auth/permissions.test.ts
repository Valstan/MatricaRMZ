import { describe, expect, it, vi } from 'vitest';

// defaultPermissionsForRole is pure, but the module (and employeeAuthService it
// pulls in transitively) imports the pg-backed db; stub it so importing does not
// construct a real connection pool.
vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));

const { defaultPermissionsForRole } = await import('./permissions.js');
const { PermissionCode } = await import('@matricarmz/shared');

describe('defaultPermissionsForRole — pending lockout (security-hardening C1)', () => {
  it('pending (self-registered, unapproved) gets NO permissions', () => {
    const perms = defaultPermissionsForRole('pending');
    expect(perms).toEqual({});
    // The dangerous ones that previously leaked via the catch-all: the dataset
    // pull capability and any view permission must be absent.
    expect(perms[PermissionCode.SyncUse]).toBeUndefined();
    expect(perms[PermissionCode.ReportsView]).toBeUndefined();
  });

  it('PENDING is normalized lower/upper-case the same way (no catch-all leak)', () => {
    expect(defaultPermissionsForRole('PENDING')).toEqual({});
  });

  it('employee still gets nothing (unchanged)', () => {
    expect(defaultPermissionsForRole('employee')).toEqual({});
  });

  it('superadmin keeps full access incl. admin-only codes', () => {
    const perms = defaultPermissionsForRole('superadmin');
    expect(perms[PermissionCode.SyncUse]).toBe(true);
    expect(perms[PermissionCode.AdminUsersManage]).toBe(true);
  });
});
