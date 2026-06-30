// Ledger write authorization policy (RBAC #474, brain #015).
//
// The real write path is /ledger/tx/submit -> applyLedgerTxs, which previously
// authorized by authentication only. This module is the PURE policy layer: it
// maps a ledger write (table + resolved entity_type / operation_type) to the
// capability an operator must hold. Enforcement (resolving the type, checking
// the actor) lives in the backend guard; this stays pure so it is unit-testable
// and shared between server gate and UI caps.
//
// Almost everything is EAV (entities + attribute_values), so the discriminator
// is the entity_type code — NOT the table. Requests/work orders live in
// `operations`, keyed by operation_type.

import { PermissionCode } from './permissions.js';
import { SyncTableName } from '../sync/tables.js';

export type LedgerWriteRequirement =
  | { kind: 'open' } // any authenticated user (per-owner/social/schema metadata)
  | { kind: 'permission'; code: PermissionCode } // operator must hold this permission
  | { kind: 'admin' } // admin/superadmin only (sensitive: contracts/customers)
  | { kind: 'superadmin' } // superadmin only (structural directories)
  | { kind: 'own_employee' }; // own employee record only (or admin) — PII

// Server-managed employee auth/security attributes (EAV `attribute_defs.code`).
// These are written ONLY by the server (setEmployeeAuth / admin routes) using a
// 'system' actor, never by a client ledger tx. The own_employee requirement
// below checks WHO owns the row but not WHICH attribute is written, so without
// this list an operator could upsert their own employee's `system_role` to
// `superadmin` (privilege escalation) or set another user's `access_enabled`
// false (lockout). The guard denies any client-submitted write of these,
// regardless of role. (security-hardening-2026-06 C2)
export const SERVER_ONLY_EMPLOYEE_ATTR_CODES: ReadonlySet<string> = new Set([
  'login',
  'password_hash',
  'system_role',
  'access_enabled',
  'delete_requested_at',
  'delete_requested_by_id',
  'delete_requested_by_username',
]);

/** True if a write targets a server-managed employee auth/security attribute. */
export function isServerOnlyEmployeeAttr(
  entityTypeCode: string | null | undefined,
  attrCode: string | null | undefined,
): boolean {
  if ((entityTypeCode ?? '').trim() !== 'employee') return false;
  return SERVER_ONLY_EMPLOYEE_ATTR_CODES.has((attrCode ?? '').trim().toLowerCase());
}

// entity_type code -> requirement (entities / attribute_values rows).
const ENTITY_TYPE_REQUIREMENT: Record<string, LedgerWriteRequirement> = {
  engine: { kind: 'permission', code: PermissionCode.EnginesEdit },
  engine_node: { kind: 'permission', code: PermissionCode.EnginesEdit },

  part: { kind: 'permission', code: PermissionCode.PartsEdit },
  part_template: { kind: 'permission', code: PermissionCode.PartsEdit },
  part_engine_brand: { kind: 'permission', code: PermissionCode.PartsEdit },
  nomenclature: { kind: 'permission', code: PermissionCode.PartsEdit },

  engine_brand: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  product: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  category: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  unit: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  tool: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  tool_property: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  tool_catalog: { kind: 'permission', code: PermissionCode.MasterDataEdit },

  service: { kind: 'permission', code: PermissionCode.ServicesEdit },
  work_order: { kind: 'permission', code: PermissionCode.WorkOrdersEdit },

  // Contracts / counterparties gate on a DEDICATED ContractsEdit permission
  // (not masterdata.edit) so contract access is granted independently of general
  // reference-data editing — a technolog who edits brands/parts does NOT get
  // contracts unless explicitly granted. Matches the UI, where the contract /
  // counterparty edit surfaces gate on caps.canEditContracts.
  contract: { kind: 'permission', code: PermissionCode.ContractsEdit },
  customer: { kind: 'permission', code: PermissionCode.ContractsEdit },
  employee: { kind: 'own_employee' },

  // structural directories — superadmin only
  workshop: { kind: 'superadmin' },
  section: { kind: 'superadmin' },
  department: { kind: 'superadmin' },
  store: { kind: 'superadmin' },
  link_field_rule: { kind: 'superadmin' },
};

// operation_type code -> requirement (operations rows). Everything except the
// supply request is engine-flow / stock work — one operator enters it all, so
// it gates on OperationsEdit (held by both engineer and master).
const OPERATION_TYPE_REQUIREMENT: Record<string, LedgerWriteRequirement> = {
  supply_request: { kind: 'permission', code: PermissionCode.SupplyRequestsEdit },
};

// Non-EAV tables. Per-owner/social/schema-metadata rows are open to any
// authenticated user (already owner-checked elsewhere); ERP entity tables map
// to the technolog/engine domain.
const TABLE_REQUIREMENT: Record<string, LedgerWriteRequirement> = {
  [SyncTableName.Notes]: { kind: 'open' },
  [SyncTableName.NoteShares]: { kind: 'open' },
  [SyncTableName.ChatMessages]: { kind: 'open' },
  [SyncTableName.ChatReads]: { kind: 'open' },
  [SyncTableName.UserPresence]: { kind: 'open' },
  [SyncTableName.AuditLog]: { kind: 'open' },
  // schema metadata — not the sensitive surface (data lives in attribute_values, which IS gated)
  [SyncTableName.EntityTypes]: { kind: 'open' },
  [SyncTableName.AttributeDefs]: { kind: 'open' },
  // stock registers are server-computed from posted documents
  [SyncTableName.ErpRegStockBalance]: { kind: 'open' },
  [SyncTableName.ErpRegStockMovements]: { kind: 'open' },
  // ERP entity tables -> technolog/engine domain
  [SyncTableName.ErpNomenclature]: { kind: 'permission', code: PermissionCode.PartsEdit },
  [SyncTableName.ErpEngineAssemblyBom]: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  [SyncTableName.ErpEngineAssemblyBomLines]: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  [SyncTableName.ErpEngineAssemblyBomBrandLinks]: { kind: 'permission', code: PermissionCode.MasterDataEdit },
  [SyncTableName.ErpEngineInstances]: { kind: 'permission', code: PermissionCode.EnginesEdit },
};

/**
 * Required capability for a single ledger write. `entityTypeCode` must be the
 * resolved entity_type code for entities/attribute_values rows; `operationType`
 * the operation_type for operations rows. Unknown/unmapped types fail OPEN
 * (availability over strictness — migration safety; sensitive types are mapped
 * explicitly). Adding a new sensitive entity_type REQUIRES a map entry here.
 */
export function ledgerWriteRequirement(args: {
  table: string;
  entityTypeCode?: string | null;
  operationType?: string | null;
}): LedgerWriteRequirement {
  const { table } = args;

  if (table === SyncTableName.Entities || table === SyncTableName.AttributeValues) {
    const code = (args.entityTypeCode ?? '').trim();
    if (!code) return { kind: 'open' };
    return ENTITY_TYPE_REQUIREMENT[code] ?? { kind: 'open' };
  }

  if (table === SyncTableName.Operations) {
    const op = (args.operationType ?? '').trim();
    return OPERATION_TYPE_REQUIREMENT[op] ?? { kind: 'permission', code: PermissionCode.OperationsEdit };
  }

  return TABLE_REQUIREMENT[table] ?? { kind: 'open' };
}

/**
 * Does an operator satisfy a requirement? Only called for operator roles — the
 * backend bypasses the gate entirely for superadmin/admin/legacy-user (so today's
 * behavior is preserved and no one breaks until reassigned a scoped role).
 *
 * `perms` is the actor's effective permission map; `ownerEntityId` is the entity
 * the row belongs to (row id for entities, entity_id for attribute_values).
 */
export function operatorMeetsRequirement(
  req: LedgerWriteRequirement,
  ctx: { perms: Record<string, boolean>; actorId: string; ownerEntityId?: string | null },
): boolean {
  switch (req.kind) {
    case 'open':
      return true;
    case 'permission':
      return ctx.perms[req.code] === true;
    case 'own_employee':
      return !!ctx.ownerEntityId && ctx.ownerEntityId === ctx.actorId;
    case 'admin':
    case 'superadmin':
      // operators are neither — these are reachable only by the bypassed roles
      return false;
  }
}
