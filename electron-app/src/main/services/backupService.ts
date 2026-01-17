import { net } from 'electron';
import { mkdirSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { httpAuthed } from './httpClient.js';
import { logMessage } from './logService.js';

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
    if (!r.ok) {
      void logMessage(db, apiBaseUrl, 'warn', `backup list failed: ${formatHttpError(r)}`, { component: 'backups', action: 'nightlyList' });
      return { ok: false, error: `list ${formatHttpError(r)}` };
    }
    if (!r.json?.ok || !Array.isArray(r.json.backups)) return { ok: false, error: 'bad list response' };
    return { ok: true, backups: r.json.backups as NightlyBackupListItem[] };
  } catch (e) {
    void logMessage(db, apiBaseUrl, 'error', `backup list error: ${String(e)}`, { component: 'backups', action: 'nightlyList' });
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

    void logMessage(db, apiBaseUrl, 'info', `backup open requested: ${date}`, {
      component: 'backups',
      action: 'nightlyEnter',
      date,
      critical: true,
    });
    const urlRes = await httpAuthed(db, apiBaseUrl, `/backups/nightly/${encodeURIComponent(date)}/url`, { method: 'GET' }, { timeoutMs: 30_000 });
    if (!urlRes.ok) {
      void logMessage(db, apiBaseUrl, 'warn', `backup url failed: ${formatHttpError(urlRes)}`, {
        component: 'backups',
        action: 'nightlyUrl',
        date,
      });
      return { ok: false, error: `url ${formatHttpError(urlRes)}` };
    }
    if (!urlRes.json?.ok || !urlRes.json.url) return { ok: false, error: 'bad url response' };
    const directUrl = String(urlRes.json.url || '');
    if (!directUrl) return { ok: false, error: 'empty url' };

    const dir = join(userDataDir, 'backup_cache');
    mkdirSync(dir, { recursive: true });
    const backupPath = join(dir, `${date}.sqlite`);

    const r = await net.fetch(directUrl);
    if (!r.ok) {
      void logMessage(db, apiBaseUrl, 'warn', `backup download failed: HTTP ${r.status}`, {
        component: 'backups',
        action: 'nightlyDownload',
        date,
        status: r.status,
      });
      return { ok: false, error: `download HTTP ${r.status}` };
    }
    const ab = await r.arrayBuffer();
    await fsp.writeFile(backupPath, Buffer.from(ab));

    void logMessage(db, apiBaseUrl, 'info', `backup download ok: ${date}`, {
      component: 'backups',
      action: 'nightlyDownload',
      date,
      critical: true,
    });
    return { ok: true, backupPath };
  } catch (e) {
    void logMessage(db, apiBaseUrl, 'error', `backup download error: ${String(e)}`, {
      component: 'backups',
      action: 'nightlyDownload',
      date: String(args?.date ?? ''),
    });
    return { ok: false, error: String(e) };
  }
}

export async function nightlyBackupRunNow(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
): Promise<{ ok: true; startedAt: number } | { ok: false; error: string }> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, '/backups/nightly/run', { method: 'POST' }, { timeoutMs: 10_000 });
    if (!r.ok) {
      void logMessage(db, apiBaseUrl, 'warn', `backup run failed: ${formatHttpError(r)}`, { component: 'backups', action: 'nightlyRun' });
      return { ok: false, error: `run ${formatHttpError(r)}` };
    }
    if (!r.json?.ok) return { ok: false, error: 'bad run response' };
    void logMessage(db, apiBaseUrl, 'info', 'backup run started', { component: 'backups', action: 'nightlyRun', critical: true });
    return { ok: true, startedAt: Number(r.json.startedAt ?? Date.now()) };
  } catch (e) {
    void logMessage(db, apiBaseUrl, 'error', `backup run error: ${String(e)}`, { component: 'backups', action: 'nightlyRun' });
    return { ok: false, error: String(e) };
  }
}


