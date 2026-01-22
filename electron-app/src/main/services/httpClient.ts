import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { authRefresh, clearSession, getSession } from './authService.js';
import { fetchWithRetry } from './netFetch.js';

export type HttpResult = {
  ok: boolean;
  status: number;
  json?: any;
  text?: string;
};

function joinUrl(base: string, path: string) {
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  const p = String(path ?? '').trim().replace(/^\/+/, '');
  return `${b}/${p}`;
}

async function readBody(r: Response): Promise<Pick<HttpResult, 'json' | 'text'>> {
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return { json: await r.json().catch(() => null) };
  return { text: await r.text().catch(() => '') };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return await fetchWithRetry(url, init, {
    attempts: 3,
    timeoutMs,
    backoffMs: 500,
    maxBackoffMs: 4000,
    jitterMs: 200,
  });
}

export async function httpAuthed(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  path: string,
  init: RequestInit,
  opts?: { timeoutMs?: number },
): Promise<HttpResult> {
  const url = joinUrl(apiBaseUrl, path);
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  const session = await getSession(db).catch(() => null);
  if (!session?.accessToken) return { ok: false, status: 401, text: 'auth required' };

  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${session.accessToken}`);

  const r1 = await fetchWithTimeout(url, { ...init, headers }, timeoutMs);
  if (r1.status !== 401 && r1.status !== 403) {
    const body = await readBody(r1);
    return { ok: r1.ok, status: r1.status, ...body };
  }

  // Refresh once and retry.
  if (session.refreshToken) {
    const refreshed = await authRefresh(db, { apiBaseUrl, refreshToken: session.refreshToken });
    if (!refreshed.ok) {
      await clearSession(db).catch(() => {});
      const body = await readBody(r1);
      return { ok: false, status: r1.status, ...body };
    }

    const headers2 = new Headers(init.headers ?? {});
    headers2.set('Authorization', `Bearer ${refreshed.accessToken}`);
    const r2 = await fetchWithTimeout(url, { ...init, headers: headers2 }, timeoutMs);
    const body2 = await readBody(r2);
    return { ok: r2.ok, status: r2.status, ...body2 };
  }

  await clearSession(db).catch(() => {});
  const body = await readBody(r1);
  return { ok: false, status: r1.status, ...body };
}


