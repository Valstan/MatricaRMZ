import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { httpAuthed } from './httpClient.js';

export type CriticalEventItem = {
  id: string;
  createdAt: number;
  source: 'client' | 'server';
  severity: 'warn' | 'error' | 'fatal';
  category: string;
  eventCode: string;
  title: string;
  humanMessage: string;
  aiDetails: string;
  username: string | null;
  clientId: string | null;
};

function safeNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeItem(row: any): CriticalEventItem | null {
  const id = String(row?.id ?? '').trim();
  if (!id) return null;
  const createdAt = safeNumber(row?.createdAt, Date.now());
  const source = String(row?.source ?? '').toLowerCase() === 'server' ? 'server' : 'client';
  const severityRaw = String(row?.severity ?? '').toLowerCase();
  const severity = severityRaw === 'fatal' ? 'fatal' : severityRaw === 'warn' ? 'warn' : 'error';
  return {
    id,
    createdAt,
    source,
    severity,
    category: String(row?.category ?? 'other'),
    eventCode: String(row?.eventCode ?? ''),
    title: String(row?.title ?? ''),
    humanMessage: String(row?.humanMessage ?? ''),
    aiDetails: String(row?.aiDetails ?? ''),
    username: row?.username == null ? null : String(row.username),
    clientId: row?.clientId == null ? null : String(row.clientId),
  };
}

export async function criticalEventsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { days?: number; limit?: number },
): Promise<{ ok: true; events: CriticalEventItem[] } | { ok: false; error: string }> {
  const days = Math.max(1, Math.min(30, safeNumber(args?.days, 3)));
  const limit = Math.max(1, Math.min(1000, safeNumber(args?.limit, 300)));
  const query = `/diagnostics/critical-events?days=${days}&limit=${limit}`;
  const res = await httpAuthed(db, apiBaseUrl, query, { method: 'GET' }, { timeoutMs: 20_000 });
  if (!res.ok) {
    return { ok: false, error: String(res.text ?? res.json?.error ?? `HTTP ${res.status}`) };
  }
  const rows = Array.isArray(res.json?.events) ? res.json.events : [];
  const events = rows.map((row: any) => normalizeItem(row)).filter((row: CriticalEventItem | null): row is CriticalEventItem => Boolean(row));
  return { ok: true, events };
}

export async function criticalEventDelete(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { id: string },
): Promise<{ ok: true; deleted: boolean } | { ok: false; error: string }> {
  const id = String(args?.id ?? '').trim();
  if (!id) return { ok: false, error: 'event id is required' };
  const query = `/diagnostics/critical-events/${encodeURIComponent(id)}`;
  const res = await httpAuthed(db, apiBaseUrl, query, { method: 'DELETE' }, { timeoutMs: 20_000 });
  if (!res.ok) {
    return { ok: false, error: String(res.text ?? res.json?.error ?? `HTTP ${res.status}`) };
  }
  return { ok: true, deleted: res.json?.deleted === true };
}

export async function criticalEventsClear(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  const query = '/diagnostics/critical-events';
  const res = await httpAuthed(db, apiBaseUrl, query, { method: 'DELETE' }, { timeoutMs: 20_000 });
  if (!res.ok) {
    return { ok: false, error: String(res.text ?? res.json?.error ?? `HTTP ${res.status}`) };
  }
  return { ok: true, deleted: Number.isFinite(Number(res.json?.deleted)) ? Number(res.json.deleted) : 0 };
}

