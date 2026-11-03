import { describe, expect, it } from 'vitest';

import {
  PermissionCode,
  PERMISSION_CATALOG,
  operatorRolePermissions,
} from './permissions.js';
import {
  isEmployeePositionAttrCode,
  ledgerWriteRequirement,
  operatorMeetsRequirement,
} from './ledgerAuthz.js';
import { SyncTableName } from '../sync/tables.js';

const ATTRS = SyncTableName.AttributeValues;

describe('узкое право на должность сотрудника (решение владельца 2026-11-03)', () => {
  it('кладовщик правит должности, но не ведёт кадровую карточку целиком', () => {
    const perms = operatorRolePermissions('storekeeper')!;
    expect(perms[PermissionCode.EmployeesPositionEdit]).toBe(true);
    // Кадровое право остаётся у кадровика: кладовщику оно не выдаётся.
    expect(perms[PermissionCode.EmployeesCreate]).toBeFalsy();
  });

  it('остальные операторские роли это право не получают', () => {
    for (const role of ['engineer', 'technolog', 'master', 'supply', 'timekeeper', 'viewer']) {
      const perms = operatorRolePermissions(role)!;
      expect(perms[PermissionCode.EmployeesPositionEdit], role).toBeFalsy();
    }
  });

  it('право описано в каталоге прав', () => {
    const entry = PERMISSION_CATALOG.find((p) => p.code === PermissionCode.EmployeesPositionEdit);
    expect(entry).toBeTruthy();
    expect(entry!.group).toBe('Сотрудники');
  });
});

describe('гейт записи должности', () => {
  it('атрибут должности опознаётся по коду', () => {
    expect(isEmployeePositionAttrCode('role')).toBe(true);
    expect(isEmployeePositionAttrCode('ROLE')).toBe(true);
    expect(isEmployeePositionAttrCode('last_name')).toBe(false);
    expect(isEmployeePositionAttrCode(null)).toBe(false);
  });

  it('требование для должности — кадровое право ИЛИ узкое право на должности', () => {
    const req = ledgerWriteRequirement({
      table: ATTRS,
      entityTypeCode: 'employee',
      attrCode: 'role',
    });
    expect(req.kind).toBe('own_employee_any');
    if (req.kind !== 'own_employee_any') throw new Error('ожидался own_employee_any');
    expect(req.code).toBe(PermissionCode.EmployeesCreate);
    expect(req.alt).toContain(PermissionCode.EmployeesPositionEdit);
  });

  it('остальные поля карточки остаются на кадровом праве', () => {
    const req = ledgerWriteRequirement({
      table: ATTRS,
      entityTypeCode: 'employee',
      attrCode: 'last_name',
    });
    expect(req).toEqual({ kind: 'own_employee', code: PermissionCode.EmployeesCreate });
  });

  it('кладовщик с узким правом пишет чужую должность и не пишет остальное', () => {
    const perms = operatorRolePermissions('storekeeper')!;
    const req = ledgerWriteRequirement({
      table: ATTRS,
      entityTypeCode: 'employee',
      attrCode: 'role',
    });
    expect(operatorMeetsRequirement(req, { perms, actorId: 'storekeeper-1', ownerEntityId: 'other-employee' })).toBe(true);

    const otherReq = ledgerWriteRequirement({
      table: ATTRS,
      entityTypeCode: 'employee',
      attrCode: 'last_name',
    });
    expect(operatorMeetsRequirement(otherReq, { perms, actorId: 'storekeeper-1', ownerEntityId: 'other-employee' })).toBe(false);
  });

  it('свою карточку сотрудник правит и без узкого права', () => {
    const perms = { [PermissionCode.EmployeesView]: true };
    const req = ledgerWriteRequirement({
      table: ATTRS,
      entityTypeCode: 'employee',
      attrCode: 'role',
    });
    expect(operatorMeetsRequirement(req, { perms, actorId: 'me', ownerEntityId: 'me' })).toBe(true);
    expect(operatorMeetsRequirement(req, { perms, actorId: 'me', ownerEntityId: 'other' })).toBe(false);
  });
});
