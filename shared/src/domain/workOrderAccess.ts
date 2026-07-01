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
 *  - A restricted owner's work orders (Ramzia) are shown only to the owner, an explicit
 *    read-allowlist (accountant Kuptsova) and the superadmin.
 *  - A restricted owner is CONFINED — they see only their own work orders.
 *  - Editing a restricted order is limited to its owner or the superadmin.
 *
 * A work order's owner is identified by its operator login: on the client that is the
 * synced `performed_by` field; on the server it is the authoritative `row_owners` entry.
 */

/** Logins whose work orders are private AND who are confined to seeing only their own. */
export const RESTRICTED_WORK_ORDER_OWNER_LOGINS: readonly string[] = ['ramzia'];
/** Read-allowlist for restricted work orders: the owner plus extra read-only readers (accountant). */
export const RESTRICTED_WORK_ORDER_READER_LOGINS: readonly string[] = ['ramzia', 'glavbux'];

function norm(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Whether a login owns restricted (private + confined) work orders. */
export function isRestrictedWorkOrderOwner(login: string | null | undefined): boolean {
  const l = norm(login);
  return l ? RESTRICTED_WORK_ORDER_OWNER_LOGINS.includes(l) : false;
}

/** Whether a login may read restricted work orders (owner + accountant). */
export function isRestrictedWorkOrderReader(login: string | null | undefined): boolean {
  const l = norm(login);
  return l ? RESTRICTED_WORK_ORDER_READER_LOGINS.includes(l) : false;
}

/** The one all-powerful level. */
export function isSuperadminRole(role: string | null | undefined): boolean {
  return norm(role) === 'superadmin';
}

/**
 * Whether a viewer may SEE a work order owned by `ownerLogin`:
 *  - superadmin + accountant (reader) → every work order;
 *  - a restricted owner (Ramzia) → only their own (confined);
 *  - an ordinary operator → every work order except a restricted owner's.
 */
export function canViewWorkOrder(args: {
  viewerLogin: string | null | undefined;
  viewerRole: string | null | undefined;
  ownerLogin: string | null | undefined;
}): boolean {
  if (isSuperadminRole(args.viewerRole)) return true;
  const viewer = norm(args.viewerLogin);
  const owner = norm(args.ownerLogin);
  if (isRestrictedWorkOrderOwner(viewer)) return owner === viewer; // confined to own
  if (isRestrictedWorkOrderReader(viewer)) return true; // accountant sees all
  return !isRestrictedWorkOrderOwner(owner); // ordinary: hide restricted owners' orders
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
}): boolean {
  if (isSuperadminRole(args.editorRole)) return true;
  if (!isRestrictedWorkOrderOwner(args.ownerLogin)) return true;
  const editor = norm(args.editorLogin);
  return editor.length > 0 && editor === norm(args.ownerLogin);
}
