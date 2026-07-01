/**
 * Role isolation for restricted work orders (Phase 3, work-order-rework-2026-06).
 *
 * Owner rule (configured by login, not hardcoded UUID):
 *  - A restricted owner's work orders (Ramzia) are PRIVATE — visible only to the
 *    owner, an explicit read-allowlist (accountant Kuptsova) and the superadmin.
 *  - A restricted owner is also CONFINED — they see ONLY their own work orders,
 *    never other people's. So Ramzia's «Наряды» list shows just her orders.
 *  - Everyone else (ordinary operators) sees every work order EXCEPT the restricted
 *    ones. The accountant and superadmin see all.
 *  - WRITE (edit) of a restricted order is allowed only for its owner or the
 *    superadmin (enforced in ledgerAuthzGuard); the accountant is read-only.
 *
 * Only work_order operations are gated. Non-work-order operations (defect,
 * completeness, …) and every other table are untouched. Plain `admin` is NOT
 * exempt from the read gate — only `superadmin` among the admin tier.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { attributeDefs, attributeValues, operations, rowOwners } from '../../database/schema.js';

/** Logins whose work orders are private AND who are confined to seeing only their own. */
const RESTRICTED_OWNER_LOGINS = ['ramzia'];
/** Read-allowlist for restricted work orders: the owner plus extra read-only readers (accountant). */
const READER_LOGINS = ['ramzia', 'glavbux'];

const WORK_ORDER = 'work_order';

function lower(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Every work order mapped to its owner login (lowercase): operation_type='work_order'
 * joined with `row_owners` (creator login, populated on create — applyPushBatch). One
 * cheap join; the whole set is small (hundreds of orders).
 */
export async function getWorkOrderOwners(): Promise<Map<string, string>> {
  // Two simple lookups (no JOIN) so this stays trivial to stub in unit tests.
  const opRows = await db
    .select({ id: operations.id })
    .from(operations)
    // Restrict regardless of deletedAt: soft-deleted work orders still retain their
    // meta_json payload, so a tombstone would otherwise leak the order's content.
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
    if (RESTRICTED_OWNER_LOGINS.includes(owner)) out.set(id, owner);
  }
  return out;
}

/** Ids of restricted work orders. */
export async function getRestrictedWorkOrderIds(): Promise<Set<string>> {
  return new Set((await getRestrictedWorkOrderOwners()).keys());
}

/** The one all-powerful level; the only admin-tier role exempt from the gate. */
export function isSuperadmin(role: string): boolean {
  return lower(role) === 'superadmin';
}

/** Whether a login is on the explicit read-allowlist (owner + accountant). */
export function isAllowlistedReader(login: string): boolean {
  const l = lower(login);
  return l ? READER_LOGINS.includes(l) : false;
}

/**
 * Whether an actor may EDIT a restricted work order owned by `ownerLogin`: only the
 * owner themselves or the superadmin. The read-allowlist accountant is read-only.
 */
export function canEditRestrictedWorkOrder(role: string, username: string, ownerLogin: string): boolean {
  if (isSuperadmin(role)) return true;
  return lower(username) === lower(ownerLogin) && lower(username).length > 0;
}

/**
 * Work-order visibility category for an actor:
 *  - `all`   — superadmin or an allowlisted reader (accountant): sees every work order.
 *  - `own`   — a confined restricted owner (Ramzia): sees only `ownIds` (their own).
 *  - `others`— an ordinary operator: sees every work order except `restrictedIds`.
 */
export type WorkOrderAccess =
  | { kind: 'all' }
  | { kind: 'own'; ownIds: Set<string>; allIds: Set<string> }
  | { kind: 'others'; restrictedIds: Set<string> };

/** Pure classifier — takes the work-order→owner map, so it is trivial to unit test. */
export function classifyWorkOrderAccess(
  role: string,
  username: string,
  workOrderOwners: Map<string, string>,
): WorkOrderAccess {
  if (isSuperadmin(role)) return { kind: 'all' };
  const login = lower(username);
  // A restricted owner is confined FIRST (even though they are also a reader): only own.
  if (login && RESTRICTED_OWNER_LOGINS.includes(login)) {
    const ownIds = new Set<string>();
    for (const [id, owner] of workOrderOwners) if (owner === login) ownIds.add(id);
    return { kind: 'own', ownIds, allIds: new Set(workOrderOwners.keys()) };
  }
  if (isAllowlistedReader(login)) return { kind: 'all' };
  const restrictedIds = new Set<string>();
  for (const [id, owner] of workOrderOwners) if (RESTRICTED_OWNER_LOGINS.includes(owner)) restrictedIds.add(id);
  return { kind: 'others', restrictedIds };
}

/** Resolve the actor's work-order access against the live owner map. */
export async function resolveWorkOrderAccess(role: string, username: string): Promise<WorkOrderAccess> {
  return classifyWorkOrderAccess(role, username, await getWorkOrderOwners());
}

/**
 * Per-row visibility for a post-filter surface (query / snapshot / report). Purely
 * id-based (works even where the row does not expose operation_type): only work_order
 * rows appear in the id sets, so every non-work-order row is always visible.
 */
export function isWorkOrderVisible(rowId: string, access: WorkOrderAccess): boolean {
  if (access.kind === 'all') return true;
  if (access.kind === 'own') return !access.allIds.has(rowId) || access.ownIds.has(rowId);
  return !access.restrictedIds.has(rowId); // 'others'
}

/**
 * Ids of work orders a client must DELETE locally to converge with its access:
 *  - `all`    → none.
 *  - `own`    → every work order that is not the actor's own (drop other people's).
 *  - `others` → the restricted work orders (drop Ramzia's).
 * Pure so it can be unit tested; the async wrapper feeds the live owner map.
 */
export function computeWorkOrderPurgeIds(
  role: string,
  username: string,
  workOrderOwners: Map<string, string>,
): string[] {
  const access = classifyWorkOrderAccess(role, username, workOrderOwners);
  if (access.kind === 'all') return [];
  if (access.kind === 'own') return [...workOrderOwners.keys()].filter((id) => !access.ownIds.has(id));
  return [...access.restrictedIds];
}

export async function getWorkOrderPurgeIds(role: string, username: string): Promise<string[]> {
  return computeWorkOrderPurgeIds(role, username, await getWorkOrderOwners());
}

/**
 * Read-allowlist check by user id — for callers that hold only an actor id (e.g. the AI
 * tool context) and not the login. Resolves the actor's `login` EAV value, then defers to
 * isAllowlistedReader. Two simple lookups (no JOIN) to stay easy to stub in tests.
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
  return isAllowlistedReader(login);
}
