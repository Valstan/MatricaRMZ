import { describe, expect, it, vi } from 'vitest';

// defaultPermissionsForRole is pure, but the module (and employeeAuthService it
// pulls in transitively) imports the pg-backed db; stub it so importing does not
// construct a real connection pool.
vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));

const { defaultPermissionsForRole } = await import('./permissions.js');
const { PermissionCode, operatorRolePermissions } = await import('@matricarmz/shared');

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

// Этапы работ заполняет и ведёт поимённый круг (владелец 15.09.2026): роль этих прав
// не даёт даже admin'у и легаси `user` — иначе «снять у всех» не держалось бы на первом
// же новом администраторе. Выдаются персональным override'ом в админке.
describe('defaultPermissionsForRole — права на этапы работ выдаются поимённо', () => {
  it('admin и легаси user не получают их от роли, остальное у admin на месте', () => {
    for (const role of ['admin', 'user']) {
      const perms = defaultPermissionsForRole(role);
      expect(perms[PermissionCode.WorkSheetsEdit], role).toBe(false);
      expect(perms[PermissionCode.WorkSheetTypesEdit], role).toBe(false);
      expect(perms[PermissionCode.OperationsEdit], role).toBe(true);
      expect(perms[PermissionCode.OperationsView], role).toBe(true);
    }
  });

  it('суперадмин — единственный, у кого они от роли', () => {
    const perms = defaultPermissionsForRole('superadmin');
    expect(perms[PermissionCode.WorkSheetsEdit]).toBe(true);
    expect(perms[PermissionCode.WorkSheetTypesEdit]).toBe(true);
  });
});

// Производственная программа (ПП): план ведут трое, названные владельцем поимённо
// (21.11.2026). Роль права не даёт даже admin'у и легаси `user` — иначе «только
// трое» держалось бы ровно до первого нового администратора. Выдаётся персональным
// override'ом.
describe('defaultPermissionsForRole — право вести ПП выдаётся поимённо', () => {
  it('admin и легаси user не получают его от роли, читать план могут', () => {
    for (const role of ['admin', 'user']) {
      const perms = defaultPermissionsForRole(role);
      expect(perms[PermissionCode.ProductionProgramEdit], role).toBe(false);
      expect(perms[PermissionCode.ProductionProgramView], role).toBe(true);
    }
  });

  it('суперадмин — единственный, у кого оно от роли', () => {
    expect(defaultPermissionsForRole('superadmin')[PermissionCode.ProductionProgramEdit]).toBe(true);
  });

  it('операторские роли его не получают, а читать план могут', () => {
    for (const role of ['engineer', 'technolog', 'master', 'supply', 'storekeeper', 'timekeeper', 'viewer']) {
      const perms = operatorRolePermissions(role)!;
      expect(perms[PermissionCode.ProductionProgramEdit], role).toBeFalsy();
      expect(perms[PermissionCode.ProductionProgramView], role).toBe(true);
    }
  });

  it('роли без доступа к программе прав не получают вовсе', () => {
    expect(defaultPermissionsForRole('pending')).toEqual({});
    expect(defaultPermissionsForRole('employee')).toEqual({});
  });
});
