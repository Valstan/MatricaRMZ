import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
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

export async function changesList(db: BetterSQLite3Database, apiBaseUrl: string, args?: { status?: string; limit?: number }) {
  const qs = new URLSearchParams();
  if (args?.status) qs.set('status', String(args.status));
  if (args?.limit != null) qs.set('limit', String(args.limit));
  const path = `/changes${qs.toString() ? `?${qs.toString()}` : ''}`;
  const r = await httpAuthed(db, apiBaseUrl, path, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function changesApply(db: BetterSQLite3Database, apiBaseUrl: string, id: string) {
  const r = await httpAuthed(db, apiBaseUrl, `/changes/${encodeURIComponent(id)}/apply`, { method: 'POST' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function changesReject(db: BetterSQLite3Database, apiBaseUrl: string, id: string) {
  const r = await httpAuthed(db, apiBaseUrl, `/changes/${encodeURIComponent(id)}/reject`, { method: 'POST' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}


