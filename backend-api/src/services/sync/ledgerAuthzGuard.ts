/**
 * Ledger write authorization guard (RBAC #474, brain #015).
 *
 * Enforcement half of the policy in shared `ledgerAuthz`. The write path
 * (/ledger/tx/submit -> applyLedgerTxs) previously authorized by authentication
 * only. This partitions a submit batch into allowed vs forbidden writes, keyed
 * by the resolved entity_type / operation_type of each row.
 *
 * Operator scoping bites ONLY the scoped operator roles. superadmin / admin /
 * legacy `user` / pending / employee keep today's behavior for that part
 * (additive migration — no one breaks until reassigned a scoped role).
 *
 * EXCEPT the server-only employee-attribute backstop (security-hardening-2026-06
 * C2), which denies writes to auth/security EAV attrs (system_role,
 * password_hash, access_enabled, login, delete_requested_*) for EVERY role —
 * those are server-managed and must never arrive via a client ledger tx.
 *
 * Forbidden rows are returned as skipped with `forbidden:<type>` so the batch is
 * not failed and the offline queue is not poisoned; the same list feeds the
 * deny-log (M3).
 */
import { inArray, isNull } from 'drizzle-orm';

import {
  isOperatorRole,
  isServerOnlyEmployeeAttr,
  ledgerWriteRequirement,
  operatorMeetsRequirement,
  SyncTableName,
} from '@matricarmz/shared';

import { getEffectivePermissionsForUser } from '../../auth/permissions.js';
import { db } from '../../database/db.js';
import { attributeDefs, entities, entityTypes } from '../../database/schema.js';
import type { SyncSkippedRow } from './applyPushBatch.js';
import { canEditRestrictedWorkOrder, getRestrictedWorkOrderOwners } from './restrictedWorkOrders.js';
import type { SyncWriteActor, SyncWriteInput } from './syncWriteService.js';

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

export async function partitionLedgerInputsByAuthz(
  inputs: SyncWriteInput[],
  actor: SyncWriteActor,
): Promise<{ allowed: SyncWriteInput[]; denied: SyncSkippedRow[] }> {
  const role = String(actor.role ?? '').toLowerCase();
  const operatorScoped = isOperatorRole(role);

  // entity_type_id -> code (small finite set)
  const typeRows = await db
    .select({ id: entityTypes.id, code: entityTypes.code })
    .from(entityTypes)
    .where(isNull(entityTypes.deletedAt));
  const codeByTypeId = new Map<string, string>();
  for (const r of typeRows) codeByTypeId.set(str(r.id), str(r.code));

  // entity_id -> entity_type_id: from this batch's entities rows first, then DB
  // for the rest (an entity created in the same batch is not yet in the DB).
  const typeIdByEntityId = new Map<string, string>();
  for (const inp of inputs) {
    if (inp.table === SyncTableName.Entities) {
      const eid = str(inp.row?.['id'] ?? inp.row_id);
      const tid = str(inp.row?.['entity_type_id']);
      if (eid && tid) typeIdByEntityId.set(eid, tid);
    }
  }
  const need = new Set<string>();
  for (const inp of inputs) {
    if (inp.table === SyncTableName.AttributeValues) {
      const eid = str(inp.row?.['entity_id']);
      if (eid && !typeIdByEntityId.has(eid)) need.add(eid);
    }
  }
  if (need.size > 0) {
    const rows = await db
      .select({ id: entities.id, entityTypeId: entities.typeId })
      .from(entities)
      .where(inArray(entities.id, [...need] as string[]));
    for (const r of rows) typeIdByEntityId.set(str(r.id), str(r.entityTypeId));
  }

  // attribute_def_id -> code, for the server-only employee-attr backstop below.
  const defIds = new Set<string>();
  for (const inp of inputs) {
    if (inp.table === SyncTableName.AttributeValues) {
      const did = str(inp.row?.['attribute_def_id']);
      if (did) defIds.add(did);
    }
  }
  const codeByDefId = new Map<string, string>();
  if (defIds.size > 0) {
    const defs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(inArray(attributeDefs.id, [...defIds] as string[]));
    for (const d of defs) codeByDefId.set(str(d.id), str(d.code));
  }

  const perms = operatorScoped ? await getEffectivePermissionsForUser(actor.id) : {};

  // Restricted work-order write isolation (Phase 3): map of restricted order id ->
  // owner login. A restricted order may be edited only by its owner or the superadmin,
  // regardless of role (so the plain `admin` / legacy `user` bypass below does not let
  // them through). Fetched once, only when the batch actually touches operations.
  const hasOps = inputs.some((i) => i.table === SyncTableName.Operations);
  const restrictedOwners = hasOps ? await getRestrictedWorkOrderOwners() : new Map<string, string>();
  const actorUsername = String(actor.username ?? '');

  const allowed: SyncWriteInput[] = [];
  const denied: SyncSkippedRow[] = [];
  for (const inp of inputs) {
    let entityTypeCode: string | null = null;
    let ownerEntityId: string | null = null;
    let operationType: string | null = null;

    if (inp.table === SyncTableName.Entities) {
      ownerEntityId = str(inp.row?.['id'] ?? inp.row_id);
      entityTypeCode = codeByTypeId.get(str(inp.row?.['entity_type_id'])) ?? null;
    } else if (inp.table === SyncTableName.AttributeValues) {
      ownerEntityId = str(inp.row?.['entity_id']);
      const tid = typeIdByEntityId.get(ownerEntityId);
      entityTypeCode = tid ? (codeByTypeId.get(tid) ?? null) : null;
    } else if (inp.table === SyncTableName.Operations) {
      operationType = str(inp.row?.['operation_type']);
    }

    // Universal backstop: server-managed employee auth/security attributes are
    // never writable via a client ledger tx, regardless of role. Operators are
    // only own_employee-scoped (which alone would let them write their OWN
    // system_role); legacy user/pending/admin otherwise bypass the gate.
    // (security-hardening-2026-06 C2)
    if (inp.table === SyncTableName.AttributeValues) {
      const attrCode = codeByDefId.get(str(inp.row?.['attribute_def_id'])) ?? null;
      if (isServerOnlyEmployeeAttr(entityTypeCode, attrCode)) {
        denied.push({
          table: inp.table,
          row_id: inp.row_id,
          reason: `forbidden:employee_auth_attr:${attrCode}`,
        });
        continue;
      }
    }

    // Restricted work-order write isolation (Phase 3): only the owner or the
    // superadmin may edit a restricted order. Runs BEFORE the non-operator bypass
    // so admin / legacy `user` (and the read-allowlist accountant) are caught too.
    if (inp.table === SyncTableName.Operations) {
      const owner = restrictedOwners.get(str(inp.row?.['id'] ?? inp.row_id));
      if (owner && !canEditRestrictedWorkOrder(role, actorUsername, owner)) {
        denied.push({ table: inp.table, row_id: inp.row_id, reason: 'forbidden:restricted_work_order' });
        continue;
      }
    }

    // Operator scoping (RBAC #474). Non-operator roles keep today's behavior
    // (additive migration) for everything except the backstop above.
    if (!operatorScoped) {
      allowed.push(inp);
      continue;
    }

    const req = ledgerWriteRequirement({ table: inp.table, entityTypeCode, operationType });
    const ok = operatorMeetsRequirement(req, { perms, actorId: actor.id, ownerEntityId });
    if (ok) {
      allowed.push(inp);
    } else {
      denied.push({
        table: inp.table,
        row_id: inp.row_id,
        reason: `forbidden:${entityTypeCode || operationType || inp.table}`,
      });
    }
  }
  return { allowed, denied };
}
