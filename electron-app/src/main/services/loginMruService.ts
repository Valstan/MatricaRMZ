import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app } from 'electron';

// Machine-local MRU of login names (never passwords). Lives directly in userData
// as a standalone JSON file — outside the synced/resettable SQLite — so it
// survives any local DB reset or full re-sync.
type LoginMruEntry = { login: string; fullName?: string; lastAt: number };

const MAX_ENTRIES = 10;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const RECENT_DAYS_DEFAULT = 10;

function mruFilePath(): string {
  return join(app.getPath('userData'), 'login-mru.json');
}

async function readEntries(): Promise<LoginMruEntry[]> {
  try {
    const raw = await readFile(mruFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed?.entries)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.entries
      .map((e: any) => {
        const fullName = String(e?.fullName ?? '').trim();
        return { login: String(e?.login ?? '').trim(), lastAt: Number(e?.lastAt ?? 0), ...(fullName ? { fullName } : {}) };
      })
      .filter((e) => e.login && Number.isFinite(e.lastAt) && e.lastAt >= cutoff)
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

async function writeEntries(entries: LoginMruEntry[]): Promise<void> {
  try {
    await writeFile(mruFilePath(), JSON.stringify({ entries }, null, 2), 'utf8');
  } catch {
    // best-effort: MRU is a convenience cache, never block auth on it
  }
}

export async function loginMruList(): Promise<string[]> {
  return (await readEntries()).map((e) => e.login);
}

/** Записи с временем последнего входа — для «был N дней назад» на экране входа. */
export async function loginMruEntries(): Promise<LoginMruEntry[]> {
  return await readEntries();
}

/** Кто входил на этом компе за последние N дней (по умолчанию 10) — для подсказки на экране входа. */
export async function loginMruRecent(days: number = RECENT_DAYS_DEFAULT): Promise<LoginMruEntry[]> {
  const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
  return (await readEntries()).filter((e) => e.lastAt >= cutoff);
}

export async function loginMruRecord(login: string, fullName?: string): Promise<void> {
  const name = String(login ?? '').trim();
  if (!name) return;
  const fn = String(fullName ?? '').trim();
  const rest = (await readEntries()).filter((e) => e.login.toLowerCase() !== name.toLowerCase());
  const entry: LoginMruEntry = { login: name, lastAt: Date.now(), ...(fn ? { fullName: fn } : {}) };
  await writeEntries([entry, ...rest].slice(0, MAX_ENTRIES));
}

export async function loginMruPruneNotIn(activeLogins: string[]): Promise<void> {
  const active = new Set(activeLogins.map((l) => String(l ?? '').trim().toLowerCase()).filter(Boolean));
  if (active.size === 0) return;
  const entries = await readEntries();
  const kept = entries.filter((e) => active.has(e.login.toLowerCase()));
  if (kept.length !== entries.length) await writeEntries(kept);
}
