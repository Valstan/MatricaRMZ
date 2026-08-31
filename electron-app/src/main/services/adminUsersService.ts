import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type {
  AdminDelegationsListResponse,
  AdminUserPermissionsResponse,
  AdminUsersListResponse,
} from '@matricarmz/shared';
import { httpAuthed } from './httpClient.js';

function formatHttpError(r: { status: number; json?: any; text?: string }): string {
  const jsonErr = r?.json && typeof r.json === 'object' ? (r.json.error ?? r.json.message ?? null) : null;
  const msg =
    typeof jsonErr === 'string'
      ? jsonErr
      : jsonErr != null
        ? JSON.stringify(jsonErr)
        : typeof r.text === 'string' && r.text.trim()
          ? r.text.trim()
          : '';
  return `HTTP ${r.status}${msg ? `: ${msg}` : ''}`;
}

export async function adminListUsers(db: BetterSQLite3Database, apiBaseUrl: string): Promise<AdminUsersListResponse> {
  const r = await httpAuthed(db, apiBaseUrl, '/admin/users', { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminCreateUser(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { login: string; password: string; role: string; fullName?: string; accessEnabled?: boolean; employeeId?: string },
) {
  const r = await httpAuthed(db, apiBaseUrl, '/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminUpdateUser(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  userId: string,
  args: { role?: string; accessEnabled?: boolean; password?: string; login?: string; fullName?: string },
) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminPendingApprove(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { pendingUserId: string; action: 'approve' | 'merge'; role?: 'user' | 'admin'; targetUserId?: string },
) {
  const r = await httpAuthed(db, apiBaseUrl, '/admin/users/pending/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminGetUserPermissions(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  userId: string,
): Promise<AdminUserPermissionsResponse> {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/permissions`, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function viewUserPermissions(db: BetterSQLite3Database, apiBaseUrl: string, userId: string) {
  const r = await httpAuthed(db, apiBaseUrl, `/auth/users/${encodeURIComponent(userId)}/permissions-view`, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminSetUserPermissions(db: BetterSQLite3Database, apiBaseUrl: string, userId: string, set: Record<string, boolean>) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/permissions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set }),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

/**
 * B3/R2: доступы по разделам пишутся серверным роутом, а не generic setAttr'ом
 * через синк. Прежний путь отправлял атрибут СУПЕРАДМИНСКОГО уровня по общему
 * каналу записи, где его приходилось ловить backstop'ом ledger-гейта, и не
 * проверял форму — в значение попадал в том числе уровень `null`, ронявший
 * пересборку зеркала. Сервер теперь валидирует громко и возвращает
 * нормализованный набор, который экран и показывает.
 */
export async function adminSetSectionAccess(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  userId: string,
  membership: Record<string, string>,
) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/section-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ membership }),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

/**
 * B3/R4a: выдать/снять ОДИН раздел. Базу набора считает сервер, поэтому
 * протухший локальный EAV этой машины ничего откатить не может.
 */
export async function adminSetSectionAccessOne(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  userId: string,
  sectionId: string,
  level: 'viewer' | 'editor' | null,
) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/section-access/one`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sectionId, level }),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminListUserDelegations(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  userId: string,
): Promise<AdminDelegationsListResponse> {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/delegations`, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminResyncEmployees(db: BetterSQLite3Database, apiBaseUrl: string) {
  const r = await httpAuthed(db, apiBaseUrl, '/admin/users/sync-snapshot', { method: 'POST' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminCreateDelegation(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { fromUserId: string; toUserId: string; permCode: string; startsAt?: number; endsAt: number; note?: string },
) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/delegations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminRevokeDelegation(db: BetterSQLite3Database, apiBaseUrl: string, id: string, note?: string) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/delegations/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note ?? undefined }),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminRequestUserDelete(db: BetterSQLite3Database, apiBaseUrl: string, userId: string) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/delete-request`, { method: 'POST' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminConfirmUserDelete(db: BetterSQLite3Database, apiBaseUrl: string, userId: string) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/delete-confirm`, { method: 'POST' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminCancelUserDelete(db: BetterSQLite3Database, apiBaseUrl: string, userId: string) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/delete-cancel`, { method: 'POST' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

// RBAC #474 M4: user-change approval queue (admin proposes -> superadmin decides).
export async function adminListUserChangeRequests(db: BetterSQLite3Database, apiBaseUrl: string) {
  const r = await httpAuthed(db, apiBaseUrl, '/admin/users/change-requests', { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminDecideUserChangeRequest(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  id: string,
  action: 'approve' | 'reject',
  note?: string,
) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/users/change-requests/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(note ? { note } : {}) }),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}


