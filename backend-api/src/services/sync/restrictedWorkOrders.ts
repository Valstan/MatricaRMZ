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

import {
  LEGACY_RESTRICTED_WORK_ORDER_POLICY,
  SECTION_ACCESS_ATTR,
  SyncTableName,
  isRestrictedWorkOrderOwner,
  isRestrictedWorkOrderReader,
  parseSectionMembership,
  restrictedWorkOrderPolicyFromMemberships,
  type RestrictedWorkOrderPolicy,
  type SectionMembership,
} from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { attributeDefs, attributeValues, operations, rowOwners } from '../../database/schema.js';

const WORK_ORDER = 'work_order';

/**
 * Configurable restricted-orders policy (Ф3): owners/readers come from the
 * `restricted_work_orders` section membership (login + section_access EAV).
 * Falls back to the legacy hardcode while no employee carries the section.
 * Cached briefly — the guard runs on every push batch.
 */
const POLICY_TTL_MS = 15_000;
let membershipRowsCache: { rows: Array<{ login: string; membership: SectionMembership }>; at: number } | null = null;

async function loadSectionMembershipRows(): Promise<Array<{ login: string; membership: SectionMembership }>> {
  const defRows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(inArray(attributeDefs.code, ['login', SECTION_ACCESS_ATTR]), isNull(attributeDefs.deletedAt)));
  const loginDefIds = defRows.filter((r) => String(r.code) === 'login').map((r) => String(r.id));
  const sectionDefIds = defRows.filter((r) => String(r.code) === SECTION_ACCESS_ATTR).map((r) => String(r.id));
  if (loginDefIds.length === 0 || sectionDefIds.length === 0) return [];
  const valRows = await db
    .select({ entityId: attributeValues.entityId, defId: attributeValues.attributeDefId, v: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.attributeDefId, [...loginDefIds, ...sectionDefIds]), isNull(attributeValues.deletedAt)));
  const loginByEntity = new Map<string, string>();
  const membershipByEntity = new Map<string, SectionMembership>();
  const loginDefs = new Set(loginDefIds);
  for (const r of valRows) {
    const eid = String(r.entityId);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(String(r.v ?? 'null'));
    } catch {
      parsed = null;
    }
    if (loginDefs.has(String(r.defId))) {
      const login = String(parsed ?? '').trim().toLowerCase();
      if (login) loginByEntity.set(eid, login);
    } else {
      membershipByEntity.set(eid, parseSectionMembership(parsed));
    }
  }
  const out: Array<{ login: string; membership: SectionMembership }> = [];
  for (const [eid, membership] of membershipByEntity) {
    const login = loginByEntity.get(eid);
    if (login) out.push({ login, membership });
  }
  return out;
}

async function cachedMembershipRows(): Promise<Array<{ login: string; membership: SectionMembership }>> {
  const now = Date.now();
  if (membershipRowsCache && now - membershipRowsCache.at < POLICY_TTL_MS) return membershipRowsCache.rows;
  let rows: Array<{ login: string; membership: SectionMembership }> = [];
  try {
    rows = await loadSectionMembershipRows();
  } catch {
    // lookup failure must not take down push/reports — callers fall back fail-open
  }
  membershipRowsCache = { rows, at: now };
  return rows;
}

export async function getRestrictedWorkOrderPolicy(): Promise<RestrictedWorkOrderPolicy> {
  const rows = await cachedMembershipRows();
  const fromMemberships = restrictedWorkOrderPolicyFromMemberships(
    rows.map((r) => ({ login: r.login, level: r.membership.restricted_work_orders ?? null })),
  );
  return fromMemberships ?? LEGACY_RESTRICTED_WORK_ORDER_POLICY;
}

/**
 * Section membership of one login (Ф3 server write-gate), or null when the
 * login carries no `section_access` attribute (unseeded — caller is fail-open).
 */
export async function getSectionMembershipForLogin(login: string | null | undefined): Promise<SectionMembership | null> {
  const l = String(login ?? '').trim().toLowerCase();
  if (!l) return null;
  const rows = await cachedMembershipRows();
  const hit = rows.find((r) => r.login === l);
  if (!hit || Object.keys(hit.membership).length === 0) return null;
  return hit.membership;
}

/** Test hook: drop the membership cache. */
export function __clearRestrictedPolicyCache(): void {
  membershipRowsCache = null;
}

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
  const policy = await getRestrictedWorkOrderPolicy();
  const out = new Map<string, string>();
  for (const [id, owner] of await getWorkOrderOwners()) {
    if (isRestrictedWorkOrderOwner(owner, policy)) out.set(id, owner);
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
  return isRestrictedWorkOrderReader(login, await getRestrictedWorkOrderPolicy());
}
