import { describe, expect, it } from 'vitest';

import { isServerOnlyEmployeeAttr, ledgerWriteRequirement, operatorMeetsRequirement } from './ledgerAuthz.js';
import { PermissionCode, operatorRolePermissions } from './permissions.js';
import { SyncTableName } from '../sync/tables.js';

const ENTITIES = SyncTableName.Entities;
const ATTRS = SyncTableName.AttributeValues;
const OPS = SyncTableName.Operations;

describe('ledgerWriteRequirement — entity types', () => {
  it('maps operational entity types to their edit permission', () => {
    expect(ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'engine' })).toEqual({
      kind: 'permission',
      code: PermissionCode.EnginesEdit,
    });
    expect(ledgerWriteRequirement({ table: ATTRS, entityTypeCode: 'part' })).toEqual({
      kind: 'permission',
      code: PermissionCode.PartsEdit,
    });
    expect(ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'service' })).toEqual({
      kind: 'permission',
      code: PermissionCode.ServicesEdit,
    });
    expect(ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'work_order' })).toEqual({
      kind: 'permission',
      code: PermissionCode.WorkOrdersEdit,
    });
  });

  it('gates contracts / counterparties on the dedicated ContractsEdit permission', () => {
    expect(ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'contract' })).toEqual({
      kind: 'permission',
      code: PermissionCode.ContractsEdit,
    });
    expect(ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'customer' })).toEqual({
      kind: 'permission',
      code: PermissionCode.ContractsEdit,
    });
  });

  it('locks sensitive and structural entity types', () => {
    expect(ledgerWriteRequirement({ table: ATTRS, entityTypeCode: 'employee' }).kind).toBe('own_employee');
    for (const t of ['workshop', 'section', 'department', 'store', 'link_field_rule']) {
      expect(ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: t }).kind, t).toBe('superadmin');
    }
  });

  it('fails open for unknown / missing entity type', () => {
    expect(ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'made_up' }).kind).toBe('open');
    expect(ledgerWriteRequirement({ table: ATTRS, entityTypeCode: null }).kind).toBe('open');
  });
});

describe('ledgerWriteRequirement — operations & tables', () => {
  it('supply_request operation needs SupplyRequestsEdit, others need OperationsEdit', () => {
    expect(ledgerWriteRequirement({ table: OPS, operationType: 'supply_request' })).toEqual({
      kind: 'permission',
      code: PermissionCode.SupplyRequestsEdit,
    });
    for (const op of ['repair', 'defect', 'assembly', 'disassembly', 'stock_receipt']) {
      expect(ledgerWriteRequirement({ table: OPS, operationType: op }), op).toEqual({
        kind: 'permission',
        code: PermissionCode.OperationsEdit,
      });
    }
  });

  it('social / schema / register tables are open', () => {
    for (const t of [
      SyncTableName.Notes,
      SyncTableName.ChatMessages,
      SyncTableName.UserPresence,
      SyncTableName.AuditLog,
      SyncTableName.EntityTypes,
      SyncTableName.AttributeDefs,
      SyncTableName.ErpRegStockMovements,
    ]) {
      expect(ledgerWriteRequirement({ table: t }).kind, t).toBe('open');
    }
  });
});

describe('isServerOnlyEmployeeAttr — C2 backstop', () => {
  it('flags server-managed employee auth/security attribute codes', () => {
    for (const code of [
      'login',
      'password_hash',
      'system_role',
      'access_enabled',
      'delete_requested_at',
      'delete_requested_by_id',
      'delete_requested_by_username',
    ]) {
      expect(isServerOnlyEmployeeAttr('employee', code), code).toBe(true);
    }
    expect(isServerOnlyEmployeeAttr('employee', 'SYSTEM_ROLE')).toBe(true); // case-insensitive
  });

  it('allows ordinary employee profile attributes', () => {
    for (const code of ['full_name', 'position', 'chat_display_name', 'telegram_login', 'ui_settings_json']) {
      expect(isServerOnlyEmployeeAttr('employee', code), code).toBe(false);
    }
  });

  it('only bites the employee entity type, and tolerates null', () => {
    expect(isServerOnlyEmployeeAttr('engine', 'system_role')).toBe(false);
    expect(isServerOnlyEmployeeAttr('contract', 'access_enabled')).toBe(false);
    expect(isServerOnlyEmployeeAttr(null, 'system_role')).toBe(false);
    expect(isServerOnlyEmployeeAttr('employee', null)).toBe(false);
  });
});

describe('operatorMeetsRequirement', () => {
  const perms = { [PermissionCode.EnginesEdit]: true } as Record<string, boolean>;

  it('permission kind checks the actor perm map', () => {
    expect(operatorMeetsRequirement({ kind: 'permission', code: PermissionCode.EnginesEdit }, { perms, actorId: 'u1' })).toBe(true);
    expect(operatorMeetsRequirement({ kind: 'permission', code: PermissionCode.PartsEdit }, { perms, actorId: 'u1' })).toBe(false);
  });

  it('own_employee allows only the actor’s own record', () => {
    expect(operatorMeetsRequirement({ kind: 'own_employee' }, { perms, actorId: 'u1', ownerEntityId: 'u1' })).toBe(true);
    expect(operatorMeetsRequirement({ kind: 'own_employee' }, { perms, actorId: 'u1', ownerEntityId: 'u2' })).toBe(false);
  });

  it('admin/superadmin requirements are never met by an operator; open always is', () => {
    expect(operatorMeetsRequirement({ kind: 'admin' }, { perms, actorId: 'u1' })).toBe(false);
    expect(operatorMeetsRequirement({ kind: 'superadmin' }, { perms, actorId: 'u1' })).toBe(false);
    expect(operatorMeetsRequirement({ kind: 'open' }, { perms, actorId: 'u1' })).toBe(true);
  });
});

// Tie the role presets (policy) to the gate (enforcement): each operator role
// must actually satisfy the requirement for its own area and fail others'.
describe('presets satisfy their own area through the gate', () => {
  function meets(role: string, req: ReturnType<typeof ledgerWriteRequirement>, ownerEntityId?: string) {
    const perms = operatorRolePermissions(role)!;
    return operatorMeetsRequirement(req, { perms, actorId: 'self', ownerEntityId: ownerEntityId ?? null });
  }

  it('engineer: engines yes, work orders no', () => {
    expect(meets('engineer', ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'engine' }))).toBe(true);
    expect(meets('engineer', ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'work_order' }))).toBe(false);
  });

  it('technolog: parts yes, engines yes (cascade), services no', () => {
    expect(meets('technolog', ledgerWriteRequirement({ table: ATTRS, entityTypeCode: 'part' }))).toBe(true);
    expect(meets('technolog', ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'engine' }))).toBe(true);
    expect(meets('technolog', ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'service' }))).toBe(false);
  });

  it('master: services + work orders + operations yes, parts no', () => {
    expect(meets('master', ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'service' }))).toBe(true);
    expect(meets('master', ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'work_order' }))).toBe(true);
    expect(meets('master', ledgerWriteRequirement({ table: OPS, operationType: 'repair' }))).toBe(true);
    expect(meets('master', ledgerWriteRequirement({ table: ATTRS, entityTypeCode: 'part' }))).toBe(false);
  });

  it('supply: supply_request yes, engine operations no', () => {
    expect(meets('supply', ledgerWriteRequirement({ table: OPS, operationType: 'supply_request' }))).toBe(true);
    expect(meets('supply', ledgerWriteRequirement({ table: OPS, operationType: 'repair' }))).toBe(false);
  });

  it('contracts need ContractsEdit: NO operator preset has it (incl. technolog); only an explicit grant passes', () => {
    expect(meets('viewer', ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'engine' }))).toBe(false);
    // No operator role carries ContractsEdit in its preset → all fail contracts/counterparties by default.
    for (const role of ['engineer', 'technolog', 'master', 'supply', 'viewer']) {
      expect(meets(role, ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'contract' })), role).toBe(false);
      expect(meets(role, ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'customer' })), role).toBe(false);
    }
    // A per-login override granting contracts.edit satisfies the gate.
    const granted = { [PermissionCode.ContractsEdit]: true } as Record<string, boolean>;
    expect(
      operatorMeetsRequirement(ledgerWriteRequirement({ table: ENTITIES, entityTypeCode: 'contract' }), { perms: granted, actorId: 'x' }),
    ).toBe(true);
    // someone else's employee record — blocked for every operator regardless.
    for (const role of ['engineer', 'technolog', 'master', 'supply', 'viewer']) {
      expect(meets(role, ledgerWriteRequirement({ table: ATTRS, entityTypeCode: 'employee' }), 'someone_else'), role).toBe(false);
    }
  });

  it('an operator may edit their OWN employee record', () => {
    const perms = operatorRolePermissions('engineer')!;
    const req = ledgerWriteRequirement({ table: ATTRS, entityTypeCode: 'employee' });
    expect(operatorMeetsRequirement(req, { perms, actorId: 'self', ownerEntityId: 'self' })).toBe(true);
  });
});
