/**
 * Role isolation for restricted work orders (Phase 3, work-order-rework-2026-06).
 *
 * A small server-side set of "restricted" owner logins whose `work_order` operations
 * are visible only to themselves, an explicit read-allowlist, and the superadmin.
 * Applied additively on all read surfaces (`/state/changes`, `/state/query`,
 * `/state/snapshot`, the report builder and the AI `get_operations` tool) so an
 * ordinary operator — or a plain `admin` — can no longer read another person's
 * restricted work orders.
 *
 * Read vs write:
 *  - READ  is allowed for the superadmin and every allowlisted reader (owner + the
 *    accountant). Plain `admin` is intentionally NOT exempt — only `superadmin`
 *    among the admin tier — because the owner's rule is "visible only to Ramzia,
 *    the accountant (Kuptsova) and the superadmin".
 *  - WRITE (edit) is allowed only for the OWNER login or the superadmin. The
 *    accountant is read-only; enforced on the push path (ledgerAuthzGuard).
 *
 * Non-restricted operations are unaffected (the gate only ever subtracts restricted
 * rows for actors who may not read them), so existing operation visibility and the
 * chat/notes privacy semantics are left untouched.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { attributeDefs, attributeValues, operations, rowOwners } from '../../database/schema.js';

/** Logins whose work orders are restricted. Identity is configured by login, not by hardcoded UUID. */
const RESTRICTED_OWNER_LOGINS = ['ramzia'];
/** Full read-allowlist for restricted work orders: the owner plus extra read-only readers (accountant). */
const READER_LOGINS = ['ramzia', 'glavbux'];

/**
 * Restricted work orders mapped to their owner login (lowercase): every
 * operation_type='work_order' owned by a restricted login. `row_owners` records the
 * creator's login in `owner_username` (populated on create — applyPushBatch), so two
 * simple lookups (no JOIN) suffice and keep this cheap and easy to stub in tests.
 */
export async function getRestrictedWorkOrderOwners(): Promise<Map<string, string>> {
  const ownerRows = await db
    .select({ rowId: rowOwners.rowId, owner: sql<string>`lower(${rowOwners.ownerUsername})` })
    .from(rowOwners)
    .where(
      and(
        eq(rowOwners.tableName, SyncTableName.Operations),
        // Case-insensitive: owner_username is written lowercase today, but match
        // defensively (mirrors isAllowlistedReader) so a mixed-case row cannot leak.
        inArray(sql`lower(${rowOwners.ownerUsername})`, RESTRICTED_OWNER_LOGINS),
      ),
    )
    .limit(50_000);
  if (ownerRows.length === 0) return new Map();
  const ownerById = new Map<string, string>();
  for (const r of ownerRows) ownerById.set(String(r.rowId), String(r.owner));
  const opRows = await db
    .select({ id: operations.id })
    .from(operations)
    // Restrict regardless of deletedAt: soft-deleted work orders still retain their
    // meta_json payload, so a tombstone would otherwise leak the order's content.
    .where(and(inArray(operations.id, [...ownerById.keys()]), eq(operations.operationType, 'work_order')))
    .limit(50_000);
  const out = new Map<string, string>();
  for (const r of opRows) {
    const id = String(r.id);
    const owner = ownerById.get(id);
    if (owner) out.set(id, owner);
  }
  return out;
}

/** Operation ids that are restricted work orders. */
export async function getRestrictedWorkOrderIds(): Promise<Set<string>> {
  return new Set((await getRestrictedWorkOrderOwners()).keys());
}

/** The one all-powerful level; the only admin-tier role exempt from the restricted-WO read gate. */
export function isSuperadmin(role: string): boolean {
  return String(role || '').toLowerCase() === 'superadmin';
}

/** Whether a login is on the explicit read-allowlist (owner + accountant). */
export function isAllowlistedReader(login: string): boolean {
  if (!login) return false;
  return READER_LOGINS.includes(login.trim().toLowerCase());
}

/**
 * Whether an actor may READ restricted work orders: the superadmin, or any login on
 * the explicit read-allowlist. Plain `admin` is deliberately excluded.
 */
export function canReadRestrictedWorkOrders(role: string, username: string): boolean {
  return isSuperadmin(role) || isAllowlistedReader(username);
}

/**
 * Whether an actor may EDIT a restricted work order owned by `ownerLogin`: only the
 * owner themselves or the superadmin. The read-allowlist accountant is read-only.
 */
export function canEditRestrictedWorkOrder(role: string, username: string, ownerLogin: string): boolean {
  if (isSuperadmin(role)) return true;
  return String(username || '').trim().toLowerCase() === String(ownerLogin || '').trim().toLowerCase();
}

/**
 * Read-allowlist check by user id — for callers that hold only an actor id (e.g. the AI tool
 * context) and not the login. Resolves the actor's `login` EAV value, then defers to
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

/**
 * Pure visibility decision for one operations row under restriction. Shared by all
 * read surfaces so they agree. A restricted row is visible only to actors who may
 * read restricted orders; every non-restricted row is visible to everyone.
 */
export function isRestrictedWorkOrderVisible(
  rowId: string,
  ctx: { restrictedIds: Set<string>; actorCanRead: boolean },
): boolean {
  if (!ctx.restrictedIds.has(rowId)) return true;
  return ctx.actorCanRead;
}
