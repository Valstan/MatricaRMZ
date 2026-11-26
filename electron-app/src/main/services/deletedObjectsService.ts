import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { httpAuthed } from './httpClient.js';
import { httpFailureLine } from './httpFailureText.js';

/**
 * «Удалённое за 3 дня» — клиентская половина: ходит на сервер.
 *
 * ПОЧЕМУ СЕРВЕР. Восстановление снимает метку удаления, а сервер отбивает «undelete» без
 * номера журнала (`applyPushBatch`), поэтому список и восстановление — серверные операции.
 * Клиент без связи с сервером покажет честную причину, а не пустой список «ничего нет».
 */
export async function adminDeletedList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { days?: number },
) {
  const q = new URLSearchParams();
  if (args?.days != null) q.set('days', String(args.days));
  const path = `/admin/deleted/list${q.toString() ? `?${q.toString()}` : ''}`;
  const r = await httpAuthed(db, apiBaseUrl, path, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: httpFailureLine(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminDeletedDescribe(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { kind: string; id: string },
) {
  const q = new URLSearchParams({ kind: args.kind, id: args.id });
  const r = await httpAuthed(db, apiBaseUrl, `/admin/deleted/describe?${q.toString()}`, { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: httpFailureLine(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminDeletedRestore(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { kind: string; id: string },
) {
  const r = await httpAuthed(
    db,
    apiBaseUrl,
    '/admin/deleted/restore',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: args.kind, id: args.id }) },
    // Восстановление меняет данные — повторять его автоматически нельзя.
    { attempts: 1 },
  );
  if (!r.ok) return { ok: false as const, error: httpFailureLine(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

export async function adminDeletedPurge(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { kind: string; id: string },
) {
  const r = await httpAuthed(
    db,
    apiBaseUrl,
    '/admin/deleted/purge',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: args.kind, id: args.id }) },
    // Окончательное удаление необратимо — повторять его автоматически нельзя.
    { attempts: 1 },
  );
  if (!r.ok) return { ok: false as const, error: httpFailureLine(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}
