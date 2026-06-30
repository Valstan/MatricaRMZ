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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, attempts = 3): Promise<Response> {
  return await fetchWithRetry(url, init, {
    attempts,
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
  // attempts: set to 1 for non-idempotent mutations (merge etc.) so a slow first
  // request is not auto-retried into a double-apply. Default 3 for reads.
  opts?: { timeoutMs?: number; attempts?: number },
): Promise<HttpResult> {
  const url = joinUrl(apiBaseUrl, path);
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const attempts = opts?.attempts ?? 3;

  const session = await getSession(db).catch(() => null);
  if (!session?.accessToken) return { ok: false, status: 401, text: 'auth required' };

  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${session.accessToken}`);

  const r1 = await fetchWithTimeout(url, { ...init, headers }, timeoutMs, attempts);
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
    const r2 = await fetchWithTimeout(url, { ...init, headers: headers2 }, timeoutMs, attempts);
    const body2 = await readBody(r2);
    return { ok: r2.ok, status: r2.status, ...body2 };
  }

  await clearSession(db).catch(() => {});
  const body = await readBody(r1);
  return { ok: false, status: r1.status, ...body };
}


