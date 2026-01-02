import { net } from 'electron';
import { mkdirSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';

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

export type NightlyBackupListItem = { date: string; name: string; size: number | null; modified: string | null };

export async function nightlyBackupsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
): Promise<{ ok: true; backups: NightlyBackupListItem[] } | { ok: false; error: string }> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, '/backups/nightly', { method: 'GET' }, { timeoutMs: 30_000 });
    if (!r.ok) return { ok: false, error: `list ${formatHttpError(r)}` };
    if (!r.json?.ok || !Array.isArray(r.json.backups)) return { ok: false, error: 'bad list response' };
    return { ok: true, backups: r.json.backups as NightlyBackupListItem[] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function nightlyBackupDownload(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { date: string; userDataDir: string },
): Promise<{ ok: true; backupPath: string } | { ok: false; error: string }> {
  try {
    const date = String(args.date || '').trim();
    if (!date) return { ok: false, error: 'date is empty' };
    const userDataDir = String(args.userDataDir || '').trim();
    if (!userDataDir) return { ok: false, error: 'userDataDir is empty' };

    const urlRes = await httpAuthed(db, apiBaseUrl, `/backups/nightly/${encodeURIComponent(date)}/url`, { method: 'GET' }, { timeoutMs: 30_000 });
    if (!urlRes.ok) return { ok: false, error: `url ${formatHttpError(urlRes)}` };
    if (!urlRes.json?.ok || !urlRes.json.url) return { ok: false, error: 'bad url response' };
    const directUrl = String(urlRes.json.url || '');
    if (!directUrl) return { ok: false, error: 'empty url' };

    const dir = join(userDataDir, 'backup_cache');
    mkdirSync(dir, { recursive: true });
    const backupPath = join(dir, `${date}.sqlite`);

    const r = await net.fetch(directUrl);
    if (!r.ok) return { ok: false, error: `download HTTP ${r.status}` };
    const ab = await r.arrayBuffer();
    await fsp.writeFile(backupPath, Buffer.from(ab));

    return { ok: true, backupPath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function nightlyBackupRunNow(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
): Promise<{ ok: true; startedAt: number } | { ok: false; error: string }> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, '/backups/nightly/run', { method: 'POST' }, { timeoutMs: 10_000 });
    if (!r.ok) return { ok: false, error: `run ${formatHttpError(r)}` };
    if (!r.json?.ok) return { ok: false, error: 'bad run response' };
    return { ok: true, startedAt: Number(r.json.startedAt ?? Date.now()) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


