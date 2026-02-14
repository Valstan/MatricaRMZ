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

export async function adminAuditList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { limit?: number; fromMs?: number; toMs?: number; actor?: string; actionType?: string },
) {
  const q = new URLSearchParams();
  if (args?.limit != null) q.set('limit', String(args.limit));
  if (args?.fromMs != null) q.set('fromMs', String(args.fromMs));
  if (args?.toMs != null) q.set('toMs', String(args.toMs));
  if (args?.actor) q.set('actor', String(args.actor));
  if (args?.actionType) q.set('actionType', String(args.actionType));
  const path = `/admin/audit/list${q.toString() ? `?${q.toString()}` : ''}`;
  const r = await httpAuthed(db, apiBaseUrl, path, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminAuditDailySummary(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { date?: string; cutoffHour?: number },
) {
  const q = new URLSearchParams();
  if (args?.date) q.set('date', String(args.date));
  if (args?.cutoffHour != null) q.set('cutoffHour', String(args.cutoffHour));
  const path = `/admin/audit/daily-summary${q.toString() ? `?${q.toString()}` : ''}`;
  const r = await httpAuthed(db, apiBaseUrl, path, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

