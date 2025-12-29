import { net } from 'electron';

import { authRefresh, clearSession, getSession } from './authService.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

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

async function fetchAuthed(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; json?: any; text?: string }> {
  const url = `${apiBaseUrl}${path}`;
  const session = await getSession(db).catch(() => null);
  if (!session?.accessToken) return { ok: false, status: 401, text: 'auth required' };

  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${session.accessToken}`);
  const r1 = await net.fetch(url, { ...init, headers });
  if (r1.status === 401 || r1.status === 403) {
    // try refresh once
    if (session.refreshToken) {
      const refreshed = await authRefresh(db, { apiBaseUrl, refreshToken: session.refreshToken });
      if (!refreshed.ok) {
        await clearSession(db).catch(() => {});
        return { ok: false, status: r1.status, text: 'auth refresh failed' };
      }
      const headers2 = new Headers(init.headers ?? {});
      headers2.set('Authorization', `Bearer ${refreshed.accessToken}`);
      const r2 = await net.fetch(url, { ...init, headers: headers2 });
      const ct = r2.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) return { ok: r2.ok, status: r2.status, json: await r2.json().catch(() => null) };
      return { ok: r2.ok, status: r2.status, text: await r2.text().catch(() => '') };
    }
    await clearSession(db).catch(() => {});
  }
  const ct = r1.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return { ok: r1.ok, status: r1.status, json: await r1.json().catch(() => null) };
  return { ok: r1.ok, status: r1.status, text: await r1.text().catch(() => '') };
}

export async function adminListUsers(db: BetterSQLite3Database, apiBaseUrl: string) {
  const r = await fetchAuthed(db, apiBaseUrl, '/admin/users', { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminCreateUser(db: BetterSQLite3Database, apiBaseUrl: string, args: { username: string; password: string; role: string }) {
  const r = await fetchAuthed(db, apiBaseUrl, '/admin/users', {
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
  args: { role?: string; isActive?: boolean; password?: string },
) {
  const r = await fetchAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminGetUserPermissions(db: BetterSQLite3Database, apiBaseUrl: string, userId: string) {
  const r = await fetchAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/permissions`, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminSetUserPermissions(db: BetterSQLite3Database, apiBaseUrl: string, userId: string, set: Record<string, boolean>) {
  const r = await fetchAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/permissions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set }),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminListUserDelegations(db: BetterSQLite3Database, apiBaseUrl: string, userId: string) {
  const r = await fetchAuthed(db, apiBaseUrl, `/admin/users/${encodeURIComponent(userId)}/delegations`, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminCreateDelegation(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { fromUserId: string; toUserId: string; permCode: string; startsAt?: number; endsAt: number; note?: string },
) {
  const r = await fetchAuthed(db, apiBaseUrl, `/admin/delegations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminRevokeDelegation(db: BetterSQLite3Database, apiBaseUrl: string, id: string, note?: string) {
  const r = await fetchAuthed(db, apiBaseUrl, `/admin/delegations/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note ?? undefined }),
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}


