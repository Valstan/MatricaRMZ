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

function isEntityTypeNotFound(error: string) {
  return String(error ?? '').toLowerCase().includes('entity type not found');
}

async function listRemoteEntityTypes(db: BetterSQLite3Database, apiBaseUrl: string) {
  const r = await httpAuthed(db, apiBaseUrl, '/admin/masterdata/entity-types', { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminResyncEntityType(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  entityTypeId: string,
  opts?: { code?: string | null },
) {
  const r = await httpAuthed(db, apiBaseUrl, `/admin/masterdata/entity-types/${encodeURIComponent(entityTypeId)}/sync-snapshot`, {
    method: 'POST',
  });
  if (r.ok) return { ...(r.json ?? { ok: false as const, error: 'bad json' }), resolvedId: entityTypeId };
  const error = formatHttpError(r);
  if (!opts?.code || !isEntityTypeNotFound(error)) return { ok: false as const, error };

  const list = await listRemoteEntityTypes(db, apiBaseUrl);
  if (!list.ok || !Array.isArray(list.rows)) return { ok: false as const, error };
  const match = list.rows.find((x: any) => String(x?.code ?? '').trim() === String(opts.code ?? '').trim());
  if (!match?.id) return { ok: false as const, error };

  const retry = await httpAuthed(
    db,
    apiBaseUrl,
    `/admin/masterdata/entity-types/${encodeURIComponent(String(match.id))}/sync-snapshot`,
    { method: 'POST' },
  );
  if (!retry.ok) return { ok: false as const, error: formatHttpError(retry) };
  return { ...(retry.json ?? { ok: false as const, error: 'bad json' }), resolvedId: String(match.id), resolvedCode: String(match.code) };
}

export async function adminResyncAllMasterdata(db: BetterSQLite3Database, apiBaseUrl: string) {
  const r = await httpAuthed(db, apiBaseUrl, '/admin/masterdata/sync-snapshot/all', { method: 'POST' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}
