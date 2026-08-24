/**
 * Work-order visibility & edit policy (shared client ↔ server).
 *
 * Architecture: every client holds the FULL database (a complete prod copy). What a
 * user may SEE is decided at DISPLAY time from the authenticated user's login + role —
 * not by filtering the sync boundary or purging the local cache (that would tie the
 * local data to whoever synced the machine and break "log in on any machine, see your
 * own settings and data"). Confidentiality here is therefore an application-layer
 * access control, not an at-rest guarantee — a deliberate owner decision.
 *
 * WRITE (edit) is still authorized server-side on the push path (integrity), using the
 * same policy so client and server agree.
 *
 * The owner's rule:
 *  - A restricted owner's work orders are shown only to the owner, an explicit
 *    read-allowlist (the accountant) and the superadmin.
 *  - A restricted owner is CONFINED — they see only their own work orders.
 *  - Editing a restricted order is limited to its owner or the superadmin.
 *
 * A work order's owner is identified by its operator login: on the client that is the
 * synced `performed_by` field; on the server it is the authoritative `row_owners` entry.
 */

/**
 * Ф3 (section-access-2026-07): WHO is restricted lives in DATA — the
 * `restricted_work_orders` section membership (editor = restricted OWNER,
 * private + confined; viewer = read-only READER). This module carries no logins.
 */
export type RestrictedWorkOrderPolicy = {
  owners: ReadonlySet<string>;
  readers: ReadonlySet<string>;
};

/**
 * Fallback when NO membership row carries the section: nobody is restricted.
 * Until 2026-08-24 this was a hardcoded pair of logins — a July-2026 snapshot of
 * the truth, long since replaced by the membership rows themselves (prod carries
 * 2 owners + 3 readers). A snapshot can only resurrect a restriction the owner
 * has already lifted; and employee logins have no place in a public repo (D-041).
 * Callers that must not fail open keep the last policy they read — see
 * `backend-api/src/services/sync/restrictedWorkOrders.ts`.
 */
export const EMPTY_RESTRICTED_WORK_ORDER_POLICY: RestrictedWorkOrderPolicy = {
  owners: new Set(),
  readers: new Set(),
};

/**
 * Build the policy from `restricted_work_orders` membership rows (login +
 * level + role). Returns null when NO row carries the section — the caller must
 * fall back to EMPTY_RESTRICTED_WORK_ORDER_POLICY. Owners read their own orders
 * by definition, so editors are included in readers.
 *
 * Superadmin rows are IGNORED: the role already bypasses sections everywhere
 * (sectionLevelFor / sectionGate / ledger authz), so a superadmin's membership
 * grants him nothing — but `restricted_work_orders: editor` silently turned HIS
 * OWN work orders private for everyone else, and the superadmin bypass in
 * canViewWorkOrder hid the damage from the one person who could notice it
 * (incident 2026-07-28: 54 orders invisible to the operators who created them
 * under his login). A membership that can only do harm is not stored — it is
 * ignored here and no longer offered in the UI.
 */
export function restrictedWorkOrderPolicyFromMemberships(
  rows: Iterable<{
    login: string | null | undefined;
    level: 'viewer' | 'editor' | null | undefined;
    role?: string | null | undefined;
  }>,
): RestrictedWorkOrderPolicy | null {
  const owners = new Set<string>();
  const readers = new Set<string>();
  let any = false;
  for (const row of rows) {
    const login = norm(row.login);
    if (!login || !row.level) continue;
    if (isSuperadminRole(row.role)) continue;
    any = true;
    if (row.level === 'editor') owners.add(login);
    readers.add(login);
  }
  return any ? { owners, readers } : null;
}

function norm(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Whether a login owns restricted (private + confined) work orders. */
export function isRestrictedWorkOrderOwner(
  login: string | null | undefined,
  policy: RestrictedWorkOrderPolicy = EMPTY_RESTRICTED_WORK_ORDER_POLICY,
): boolean {
  const l = norm(login);
  return l ? policy.owners.has(l) : false;
}

/** Whether a login may read restricted work orders (owner + accountant). */
export function isRestrictedWorkOrderReader(
  login: string | null | undefined,
  policy: RestrictedWorkOrderPolicy = EMPTY_RESTRICTED_WORK_ORDER_POLICY,
): boolean {
  const l = norm(login);
  return l ? policy.readers.has(l) : false;
}

/** The one all-powerful level. */
export function isSuperadminRole(role: string | null | undefined): boolean {
  return norm(role) === 'superadmin';
}

/**
 * Whether a viewer may SEE a work order owned by `ownerLogin`:
 *  - superadmin + accountant (reader) → every work order;
 *  - a restricted owner → only their own (confined);
 *  - an ordinary operator → every work order except a restricted owner's.
 */
export function canViewWorkOrder(args: {
  viewerLogin: string | null | undefined;
  viewerRole: string | null | undefined;
  ownerLogin: string | null | undefined;
  policy?: RestrictedWorkOrderPolicy;
}): boolean {
  if (isSuperadminRole(args.viewerRole)) return true;
  const policy = args.policy ?? EMPTY_RESTRICTED_WORK_ORDER_POLICY;
  const viewer = norm(args.viewerLogin);
  const owner = norm(args.ownerLogin);
  if (isRestrictedWorkOrderOwner(viewer, policy)) return owner === viewer; // confined to own
  if (isRestrictedWorkOrderReader(viewer, policy)) return true; // accountant sees all
  return !isRestrictedWorkOrderOwner(owner, policy); // ordinary: hide restricted owners' orders
}

/**
 * Whether an editor may EDIT a work order owned by `ownerLogin`. Only restricts the
 * RESTRICTED owners' orders (to owner + superadmin); ordinary orders return true here
 * and stay governed by the normal RBAC write authz.
 */
export function canEditWorkOrder(args: {
  editorLogin: string | null | undefined;
  editorRole: string | null | undefined;
  ownerLogin: string | null | undefined;
  policy?: RestrictedWorkOrderPolicy;
}): boolean {
  if (isSuperadminRole(args.editorRole)) return true;
  const policy = args.policy ?? EMPTY_RESTRICTED_WORK_ORDER_POLICY;
  if (!isRestrictedWorkOrderOwner(args.ownerLogin, policy)) return true;
  const editor = norm(args.editorLogin);
  return editor.length > 0 && editor === norm(args.ownerLogin);
}
