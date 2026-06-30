import { describe, expect, it } from 'vitest';

import {
  PermissionCode,
  PERMISSION_CATALOG,
  SYSTEM_ROLE_CATALOG,
  isOperatorRole,
  operatorRolePermissions,
  systemRoleTitleRu,
} from './permissions.js';

describe('permissions catalog', () => {
  it('contains unique codes', () => {
    const codes = PERMISSION_CATALOG.map((p) => p.code);
    const uniq = new Set(codes);
    expect(uniq.size).toBe(codes.length);
  });

  it('covers only known PermissionCode values', () => {
    const all = new Set(Object.values(PermissionCode));
    const unknown = PERMISSION_CATALOG.map((p) => p.code).filter((code) => !all.has(code));
    expect(unknown).toEqual([]);
  });
});

describe('operator role presets (RBAC #474)', () => {
  it('non-operator roles return null (backend handles full/none)', () => {
    for (const role of ['superadmin', 'admin', 'user', 'pending', 'employee', 'unknown']) {
      expect(operatorRolePermissions(role)).toBeNull();
      expect(isOperatorRole(role)).toBe(false);
    }
  });

  it('every operator role grants the read-only base but never admin-only', () => {
    for (const role of ['engineer', 'technolog', 'master', 'supply', 'timekeeper', 'viewer']) {
      const perms = operatorRolePermissions(role);
      expect(perms, role).not.toBeNull();
      expect(isOperatorRole(role)).toBe(true);
      expect(perms![PermissionCode.EnginesView]).toBe(true);
      expect(perms![PermissionCode.ReportsView]).toBe(true);
      expect(perms![PermissionCode.AdminUsersManage]).toBeFalsy();
      expect(perms![PermissionCode.ClientsManage]).toBeFalsy();
    }
  });

  it('viewer can edit nothing', () => {
    const perms = operatorRolePermissions('viewer')!;
    expect(perms[PermissionCode.EnginesEdit]).toBeFalsy();
    expect(perms[PermissionCode.WorkOrdersEdit]).toBeFalsy();
    expect(perms[PermissionCode.PartsEdit]).toBeFalsy();
    expect(perms[PermissionCode.TimesheetEdit]).toBeFalsy();
  });

  it('engineer edits engines/operations but not work orders or timesheet', () => {
    const perms = operatorRolePermissions('engineer')!;
    expect(perms[PermissionCode.EnginesEdit]).toBe(true);
    expect(perms[PermissionCode.OperationsEdit]).toBe(true);
    expect(perms[PermissionCode.EnginesDisassembleConfirm]).toBe(true);
    expect(perms[PermissionCode.WorkOrdersEdit]).toBeFalsy();
    expect(perms[PermissionCode.WorkOrdersClose]).toBeFalsy();
    expect(perms[PermissionCode.TimesheetEdit]).toBeFalsy();
    expect(perms[PermissionCode.SupplyRequestsCreate]).toBeFalsy();
  });

  it('master edits work orders/operations/services but not engines or parts', () => {
    const perms = operatorRolePermissions('master')!;
    expect(perms[PermissionCode.WorkOrdersCreate]).toBe(true);
    expect(perms[PermissionCode.WorkOrdersClose]).toBe(true);
    expect(perms[PermissionCode.WorkOrdersRevert]).toBe(true);
    expect(perms[PermissionCode.WarehouseAssemblyReturn]).toBe(true);
    expect(perms[PermissionCode.OperationsEdit]).toBe(true);
    expect(perms[PermissionCode.ServicesEdit]).toBe(true);
    expect(perms[PermissionCode.EnginesEdit]).toBeFalsy();
    expect(perms[PermissionCode.PartsEdit]).toBeFalsy();
  });

  it('technolog edits parts/masterdata and engines (cascade) but not work orders', () => {
    const perms = operatorRolePermissions('technolog')!;
    expect(perms[PermissionCode.PartsCreate]).toBe(true);
    expect(perms[PermissionCode.PartsDelete]).toBe(true);
    expect(perms[PermissionCode.MasterDataEdit]).toBe(true);
    expect(perms[PermissionCode.EnginesEdit]).toBe(true);
    expect(perms[PermissionCode.WorkOrdersClose]).toBeFalsy();
    expect(perms[PermissionCode.TimesheetEdit]).toBeFalsy();
  });

  it('supply edits requests but sign/approve stay per-person (overrides)', () => {
    const perms = operatorRolePermissions('supply')!;
    expect(perms[PermissionCode.SupplyRequestsCreate]).toBe(true);
    expect(perms[PermissionCode.SupplyRequestsEdit]).toBe(true);
    expect(perms[PermissionCode.SupplyRequestsSign]).toBeFalsy();
    expect(perms[PermissionCode.SupplyRequestsDirectorApprove]).toBeFalsy();
    expect(perms[PermissionCode.WorkOrdersEdit]).toBeFalsy();
  });

  it('timekeeper edits only the timesheet', () => {
    const perms = operatorRolePermissions('timekeeper')!;
    expect(perms[PermissionCode.TimesheetEdit]).toBe(true);
    expect(perms[PermissionCode.TimesheetView]).toBe(true);
    expect(perms[PermissionCode.PartsEdit]).toBeFalsy();
    expect(perms[PermissionCode.WorkOrdersEdit]).toBeFalsy();
  });

  it('catalog covers every operator role with a Russian label', () => {
    for (const role of ['engineer', 'technolog', 'master', 'supply', 'timekeeper', 'viewer']) {
      const meta = SYSTEM_ROLE_CATALOG.find((r) => r.key === role);
      expect(meta, role).toBeDefined();
      expect(meta!.kind).toBe('operator');
      expect(systemRoleTitleRu(role)).toBe(meta!.titleRu);
      expect(systemRoleTitleRu(role)).not.toBe(role);
    }
  });
});
