/**
 * Role isolation for restricted work orders (Phase 3c, work-order-rework-2026-06).
 *
 * A small server-side set of "restricted" owner logins whose `work_order` operations
 * are visible only to themselves, an explicit read-allowlist, and admins/superadmins.
 * Applied additively on all three sync pull surfaces (`/state/changes`, `/state/query`,
 * `/state/snapshot`) so an ordinary operator can no longer pull another person's
 * restricted work orders.
 *
 * This is read-visibility isolation only. Write-side blocking for the read-allowlist
 * (e.g. the accountant may read but not edit) is a separate follow-up guard on the
 * push path; it is intentionally out of scope here.
 *
 * Non-restricted operations are unaffected (the gate only ever subtracts restricted
 * rows for non-allowlisted, non-admin actors), so existing operation visibility and
 * the chat/notes privacy semantics are left untouched.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { attributeDefs, attributeValues, operations, rowOwners } from '../../database/schema.js';

/** Logins whose work orders are restricted. Identity is configured by login, not by hardcoded UUID. */
const RESTRICTED_OWNER_LOGINS = ['ramzia'];
/** Full read-allowlist for restricted work orders: the owner plus extra read-only readers. */
const READER_LOGINS = ['ramzia', 'glavbux'];

/**
 * Operation ids that are restricted work orders (operation_type='work_order' owned by a
 * restricted login). `row_owners` already records the creator's login in `owner_username`
 * (populated on create — applyPushBatch), so two simple lookups (no JOIN) suffice and keep
 * this cheap and easy to stub in unit tests.
 */
export async function getRestrictedWorkOrderIds(): Promise<Set<string>> {
  const ownerRows = await db
    .select({ rowId: rowOwners.rowId })
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
  const candidateIds = ownerRows.map((r) => String(r.rowId));
  if (candidateIds.length === 0) return new Set();
  const opRows = await db
    .select({ id: operations.id })
    .from(operations)
    // Restrict regardless of deletedAt: soft-deleted work orders still retain their
    // meta_json payload, so a tombstone would otherwise leak the order's content.
    .where(and(inArray(operations.id, candidateIds), eq(operations.operationType, 'work_order')))
    .limit(50_000);
  return new Set(opRows.map((r) => String(r.id)));
}

/** Whether a login may read restricted work orders (owner + explicit readers; admins handled by the caller). */
export function isAllowlistedReader(login: string): boolean {
  if (!login) return false;
  return READER_LOGINS.includes(login.trim().toLowerCase());
}

/**
 * Allowlist check by user id — for callers that hold only an actor id (e.g. the AI tool
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
 * three pull surfaces so they agree. A restricted row is visible only to admins or
 * allowlisted readers; every non-restricted row is visible to everyone.
 */
export function isRestrictedWorkOrderVisible(
  rowId: string,
  ctx: { restrictedIds: Set<string>; actorIsAdmin: boolean; actorIsAllowlisted: boolean },
): boolean {
  if (!ctx.restrictedIds.has(rowId)) return true;
  return ctx.actorIsAdmin || ctx.actorIsAllowlisted;
}
