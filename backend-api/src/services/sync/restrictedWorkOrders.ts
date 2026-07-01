/**
 * Server-side owner lookups for the work-order isolation policy (Phase 3,
 * work-order-rework-2026-06). The policy itself lives in shared `workOrderAccess`
 * (canViewWorkOrder / canEditWorkOrder) so client and server agree.
 *
 * Sync is NOT filtered by this any more: every client holds the full database and
 * hides restricted orders at DISPLAY time. These helpers back the two server-side
 * per-request checks that must stay authoritative:
 *  - the ledger WRITE guard (only the owner or superadmin may edit a restricted order);
 *  - the report builder (a server-rendered artifact is filtered for the requesting user).
 *
 * A work order's authoritative owner is its `row_owners` entry (creator login, populated
 * on create — applyPushBatch).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { SyncTableName, isRestrictedWorkOrderOwner, isRestrictedWorkOrderReader } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { attributeDefs, attributeValues, operations, rowOwners } from '../../database/schema.js';

const WORK_ORDER = 'work_order';

/**
 * Every work order mapped to its owner login (lowercase): operation_type='work_order'
 * joined with `row_owners`. Two simple lookups (no JOIN) so this stays trivial to stub.
 */
export async function getWorkOrderOwners(): Promise<Map<string, string>> {
  const opRows = await db
    .select({ id: operations.id })
    .from(operations)
    // Regardless of deletedAt: a soft-deleted work order still retains its meta_json.
    .where(eq(operations.operationType, WORK_ORDER))
    .limit(50_000);
  if (opRows.length === 0) return new Map();
  const woIds = opRows.map((r) => String(r.id));
  const ownerRows = await db
    .select({ rowId: rowOwners.rowId, owner: sql<string>`lower(${rowOwners.ownerUsername})` })
    .from(rowOwners)
    .where(and(eq(rowOwners.tableName, SyncTableName.Operations), inArray(rowOwners.rowId, woIds)))
    .limit(50_000);
  const out = new Map<string, string>();
  for (const r of ownerRows) out.set(String(r.rowId), String(r.owner));
  return out;
}

/** Restricted work orders (owned by a restricted login) mapped to their owner login. */
export async function getRestrictedWorkOrderOwners(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [id, owner] of await getWorkOrderOwners()) {
    if (isRestrictedWorkOrderOwner(owner)) out.set(id, owner);
  }
  return out;
}

/** Ids of restricted work orders (used by the AI get_operations gate). */
export async function getRestrictedWorkOrderIds(): Promise<Set<string>> {
  return new Set((await getRestrictedWorkOrderOwners()).keys());
}

/**
 * Read-allowlist check by user id — for callers that hold only an actor id (e.g. the AI
 * tool context) and not the login. Resolves the actor's `login` EAV value, then defers to
 * the shared reader check. Two simple lookups (no JOIN) to stay easy to stub in tests.
 */
export async function isAllowlistedReaderById(actorId: string): Promise<boolean> {
  if (!actorId) return false;
  const defRows = await db.select({ id: attributeDefs.id }).from(attributeDefs).where(eq(attributeDefs.code, 'login')).limit(50);
  const defIds = defRows.map((r) => String(r.id));
  if (defIds.length === 0) return false;
  const valRows = await db
    .select({ v: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, actorId), inArray(attributeValues.attributeDefId, defIds), isNull(attributeValues.deletedAt)))
    .limit(1);
  if (valRows.length === 0) return false;
  let login = '';
  try {
    login = String(JSON.parse(String(valRows[0]!.v ?? '""')) ?? '');
  } catch {
    login = '';
  }
  return isRestrictedWorkOrderReader(login);
}
