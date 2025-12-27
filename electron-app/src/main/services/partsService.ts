import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { net } from 'electron';

import { getSession } from './authService.js';
import { authRefresh, clearSession } from './authService.js';

async function fetchAuthedJson(
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
    if (session.refreshToken) {
      const refreshed = await authRefresh(db, { apiBaseUrl, refreshToken: session.refreshToken });
      if (!refreshed.ok) {
        await clearSession(db).catch(() => {});
        return { ok: false, status: r1.status, text: 'auth refresh failed' };
      }
      const headers2 = new Headers(init.headers ?? {});
      headers2.set('Authorization', `Bearer ${refreshed.accessToken}`);
      const r2 = await net.fetch(url, { ...init, headers: headers2 });
      return { ok: r2.ok, status: r2.status, json: await r2.json().catch(() => null), text: await r2.text().catch(() => '') };
    }
    await clearSession(db).catch(() => {});
  }
  return { ok: r1.ok, status: r1.status, json: await r1.json().catch(() => null), text: await r1.text().catch(() => '') };
}

export async function partsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { q?: string; limit?: number },
): Promise<
  | {
      ok: true;
      parts: Array<{
        id: string;
        name?: string;
        article?: string;
        updatedAt: number;
        createdAt: number;
      }>;
    }
  | { ok: false; error: string }
> {
  try {
    const queryParams = new URLSearchParams();
    if (args?.q) queryParams.set('q', args.q);
    if (args?.limit) queryParams.set('limit', String(args.limit));

    const url = `/parts${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    const r = await fetchAuthedJson(db, apiBaseUrl, url, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `list HTTP ${r.status}: ${r.text ?? ''}`.trim() };
    if (!r.json?.ok) return { ok: false, error: 'bad list response' };
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsGet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { partId: string },
): Promise<
  | {
      ok: true;
      part: {
        id: string;
        createdAt: number;
        updatedAt: number;
        attributes: Array<{
          id: string;
          code: string;
          name: string;
          dataType: string;
          value: unknown;
          isRequired: boolean;
          sortOrder: number;
          metaJson?: unknown;
        }>;
      };
    }
  | { ok: false; error: string }
> {
  try {
    const partId = String(args.partId || '');
    if (!partId) return { ok: false, error: 'partId is empty' };

    const r = await fetchAuthedJson(db, apiBaseUrl, `/parts/${encodeURIComponent(partId)}`, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `get HTTP ${r.status}: ${r.text ?? ''}`.trim() };
    if (!r.json?.ok) return { ok: false, error: 'bad get response' };
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsCreate(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { attributes?: Record<string, unknown> },
): Promise<
  | {
      ok: true;
      part: { id: string; createdAt: number; updatedAt: number };
    }
  | { ok: false; error: string }
> {
  try {
    const r = await fetchAuthedJson(db, apiBaseUrl, '/parts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: args?.attributes }),
    });
    if (!r.ok) return { ok: false, error: `create HTTP ${r.status}: ${r.text ?? ''}`.trim() };
    if (!r.json?.ok) return { ok: false, error: 'bad create response' };
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsUpdateAttribute(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { partId: string; attributeCode: string; value: unknown },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const partId = String(args.partId || '');
    const attrCode = String(args.attributeCode || '');
    if (!partId || !attrCode) return { ok: false, error: 'partId or attributeCode is empty' };

    const r = await fetchAuthedJson(db, apiBaseUrl, `/parts/${encodeURIComponent(partId)}/attributes/${encodeURIComponent(attrCode)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: args.value }),
    });
    if (!r.ok) return { ok: false, error: `update HTTP ${r.status}: ${r.text ?? ''}`.trim() };
    if (!r.json?.ok) return { ok: false, error: 'bad update response' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsDelete(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { partId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const partId = String(args.partId || '');
    if (!partId) return { ok: false, error: 'partId is empty' };

    const r = await fetchAuthedJson(db, apiBaseUrl, `/parts/${encodeURIComponent(partId)}`, { method: 'DELETE' });
    if (!r.ok) return { ok: false, error: `delete HTTP ${r.status}: ${r.text ?? ''}`.trim() };
    if (!r.json?.ok) return { ok: false, error: 'bad delete response' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsGetFiles(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { partId: string },
): Promise<
  | {
      ok: true;
      files: unknown[];
    }
  | { ok: false; error: string }
> {
  try {
    const partId = String(args.partId || '');
    if (!partId) return { ok: false, error: 'partId is empty' };

    const r = await fetchAuthedJson(db, apiBaseUrl, `/parts/${encodeURIComponent(partId)}/files`, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `getFiles HTTP ${r.status}: ${r.text ?? ''}`.trim() };
    if (!r.json?.ok) return { ok: false, error: 'bad getFiles response' };
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
