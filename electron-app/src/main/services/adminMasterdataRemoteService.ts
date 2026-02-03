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

export async function adminResyncEntityType(db: BetterSQLite3Database, apiBaseUrl: string, entityTypeId: string) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/masterdata/entity-types/${encodeURIComponent(entityTypeId)}/sync-snapshot`, {
    method: 'POST',
  });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminResyncAllMasterdata(db: BetterSQLite3Database, apiBaseUrl: string) {
  const r = await httpAuthed(db, apiBaseUrl, '/admin/masterdata/sync-snapshot/all', { method: 'POST' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}
