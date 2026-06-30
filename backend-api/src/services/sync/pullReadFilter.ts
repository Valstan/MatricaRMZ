/**
 * Pull read-authz (RBAC #474 M2b; security-hardening-2026-06 H1-B1a).
 *
 * A single per-row predicate applied to every pull surface (/state/snapshot,
 * /state/changes, /state/query). For employee attribute_values:
 *
 *  - CREDENTIALS (password_hash): dropped for EVERYONE incl. admins — auth is
 *    server-side only (auth.ts verifyPassword), no client ever consumes the hash,
 *    so syncing it to client SQLite is pure credential exposure (offline cracking).
 *  - SENSITIVE PII (salary/passport/inn/snils) + HR-sensitive (birth_date,
 *    hire_date): visible only to the employee's OWN record, for OPERATOR roles.
 *    Non-operator roles (admin/superadmin and legacy `user`) are unaffected —
 *    matching the prior contract; the legacy-`user` clamp is a separate migration
 *    (plan §12 prerequisite), not B1a.
 *  - DELIBERATELY KEPT broadly visible: login (resolves to ФИО client-side),
 *    employment_status AND termination_date (resolveEmploymentStatusCode treats
 *    termination_date as the authoritative "fired" signal — the timekeeper roster
 *    reads it for all employees), ФИО/position/department.
 *  - DEFERRED (not B1a): system_role / access_enabled — withholding them makes the
 *    operator EmployeesPage «Доступ» column read "запрещено" for colleagues; needs
 *    a coordinated renderer fix. delete_requested_* — handle with the same step.
 *
 * Table-level: audit_log is admin-only on pull (no live operator page reads the
 * synced audit_log — see docs/plans/h1-table-read-authz-2026-06.md §12). Use
 * isPullTableAllowedForRole at the surface level to skip fetching it entirely.
 *
 * Resolution is cheap: an employee attribute's attribute_def_id encodes both the
 * entity type (employee) and the field, so we precompute the def-id sets once
 * (cached) and each per-row check is O(1).
 */
import { and, eq, isNull } from 'drizzle-orm';

import { SyncTableName, isOperatorRole } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { attributeDefs, entityTypes } from '../../database/schema.js';
import { isHiddenAttributeName } from '../ai/sensitiveFilter.js';

type Actor = { id: string; role?: string | null | undefined };

// Employee EAV attribute codes that are a credential — no client needs them.
const CREDENTIAL_CODES = new Set<string>(['password_hash']);

// Employee EAV attribute codes visible only to the employee themself (operators).
// NOT here on purpose: termination_date / employment_status (roster authority),
// login (ФИО resolution), system_role / access_enabled (deferred — «Доступ» column).
const HR_SENSITIVE_CODES = new Set<string>(['birth_date', 'hire_date']);

// Sync tables an operator never needs and that carry admin-only data.
const ADMIN_ONLY_PULL_TABLES = new Set<string>([SyncTableName.AuditLog]);

const CACHE_TTL_MS = 60_000;
type DefSets = { credential: Set<string>; restricted: Set<string>; at: number };
let cache: DefSets | null = null;

async function employeeDefSets(): Promise<DefSets> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache;
  const credential = new Set<string>();
  const restricted = new Set<string>(); // PII + HR-sensitive (own-or-admin only)
  const empType = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'employee'), isNull(entityTypes.deletedAt)))
    .limit(1);
  if (empType[0]) {
    const defs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code, name: attributeDefs.name })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, empType[0].id), isNull(attributeDefs.deletedAt)));
    for (const d of defs) {
      const code = String(d.code ?? '').trim().toLowerCase();
      if (CREDENTIAL_CODES.has(code)) credential.add(String(d.id));
      else if (HR_SENSITIVE_CODES.has(code)) restricted.add(String(d.id));
      else if (isHiddenAttributeName(d.code) || isHiddenAttributeName(d.name)) restricted.add(String(d.id));
    }
  }
  cache = { credential, restricted, at: now };
  return cache;
}

/** Drops the cache (call after attribute-def changes if immediacy is needed). */
export function resetPullReadFilterCache(): void {
  cache = null;
}

function isAdminRole(role: string | null | undefined): boolean {
  const r = String(role ?? '').toLowerCase();
  return r === 'admin' || r === 'superadmin';
}

/** False if `role` must not receive `table` at all on pull (skip the fetch). */
export function isPullTableAllowedForRole(table: string, role: string | null | undefined): boolean {
  if (ADMIN_ONLY_PULL_TABLES.has(table) && !isAdminRole(role)) return false;
  return true;
}

/**
 * Per-row visibility predicate for the actor, applied at every pull surface.
 * The predicate takes a table name and the row object (sync row OR parsed
 * payload — both carry `entity_id` / `attribute_def_id`). Always returns a
 * predicate (never null) so credential stripping applies to admins too.
 */
export async function makePullReadFilter(
  actor: Actor,
): Promise<(table: string, row: Record<string, unknown>) => boolean> {
  const sets = await employeeDefSets();
  const isAdmin = isAdminRole(actor.role);
  const isOperator = isOperatorRole(String(actor.role ?? '').toLowerCase());
  return (table, row) => {
    if (!isAdmin && ADMIN_ONLY_PULL_TABLES.has(table)) return false;
    if (table !== SyncTableName.AttributeValues) return true;
    const defId = String(row['attribute_def_id'] ?? '');
    if (sets.credential.has(defId)) return false; // credential — drop for everyone
    if (isOperator && sets.restricted.has(defId)) {
      // sensitive PII / HR — operators see only their OWN record
      return String(row['entity_id'] ?? '') === actor.id;
    }
    return true;
  };
}
