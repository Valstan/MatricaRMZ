import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { httpAuthed } from './httpClient.js';
import { httpFailureLine } from './httpFailureText.js';


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
  if (!r.ok) return { ok: false as const, error: httpFailureLine(r) };
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
  if (!r.ok) return { ok: false as const, error: httpFailureLine(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}


/** История одного документа: кто и когда открывал и правил эту карточку. */
export async function adminAuditDocument(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { entityId: string; limit?: number },
) {
  const q = new URLSearchParams({ entityId: String(args.entityId) });
  if (args.limit != null) q.set('limit', String(args.limit));
  const r = await httpAuthed(db, apiBaseUrl, `/admin/audit/document?${q.toString()}`, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: httpFailureLine(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}
