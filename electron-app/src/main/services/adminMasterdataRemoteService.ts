import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { httpAuthed } from './httpClient.js';

const RETRYABLE_GATEWAY_STATUSES = new Set([502, 503, 504]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(raw: string): string {
  const text = String(raw ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function shortBodyMessage(raw: string): string {
  const text = stripHtml(raw);
  if (!text) return '';
  if (text.length <= 180) return text;
  return `${text.slice(0, 177)}...`;
}

function formatHttpError(r: { status: number; json?: any; text?: string }): string {
  if (RETRYABLE_GATEWAY_STATUSES.has(Number(r?.status ?? 0))) {
    return `HTTP ${r.status}: сервер временно недоступен (gateway)`;
  }
  const jsonErr = r?.json && typeof r.json === 'object' ? (r.json.error ?? r.json.message ?? null) : null;
  const msg =
    typeof jsonErr === 'string'
      ? jsonErr
      : jsonErr != null
        ? JSON.stringify(jsonErr)
        : typeof r.text === 'string' && r.text.trim()
          ? shortBodyMessage(r.text)
          : '';
  return `HTTP ${r.status}${msg ? `: ${msg}` : ''}`;
}

function isEntityTypeNotFound(error: string) {
  return String(error ?? '').toLowerCase().includes('entity type not found');
}

async function listRemoteEntityTypes(db: BetterSQLite3Database, apiBaseUrl: string) {
  const r = await httpAuthedWithGatewayRetry(db, apiBaseUrl, '/admin/masterdata/entity-types', { method: 'GET' }, { timeoutMs: 45_000 });
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}

async function httpAuthedWithGatewayRetry(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  path: string,
  init: RequestInit,
  opts?: { timeoutMs?: number },
) {
  let last: Awaited<ReturnType<typeof httpAuthed>> | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await httpAuthed(db, apiBaseUrl, path, init, opts);
    last = res;
    if (res.ok) return res;
    if (!RETRYABLE_GATEWAY_STATUSES.has(Number(res.status ?? 0)) || attempt >= 3) return res;
    await sleep(attempt * 800);
  }
  return (
    last ?? {
      ok: false,
      status: 0,
      text: 'request failed',
    }
  );
}

export async function adminResyncEntityType(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  entityTypeId: string,
  opts?: { code?: string | null },
) {
  const r = await httpAuthedWithGatewayRetry(
    db,
    apiBaseUrl,
    `/admin/masterdata/entity-types/${encodeURIComponent(entityTypeId)}/sync-snapshot`,
    {
      method: 'POST',
    },
    { timeoutMs: 90_000 },
  );
  if (r.ok) return { ...(r.json ?? { ok: false as const, error: 'bad json' }), resolvedId: entityTypeId };
  const error = formatHttpError(r);
  if (!opts?.code || !isEntityTypeNotFound(error)) return { ok: false as const, error };

  const list = await listRemoteEntityTypes(db, apiBaseUrl);
  if (!list.ok || !Array.isArray(list.rows)) return { ok: false as const, error };
  const match = list.rows.find((x: any) => String(x?.code ?? '').trim() === String(opts.code ?? '').trim());
  if (!match?.id) return { ok: false as const, error };

  const retry = await httpAuthedWithGatewayRetry(
    db,
    apiBaseUrl,
    `/admin/masterdata/entity-types/${encodeURIComponent(String(match.id))}/sync-snapshot`,
    { method: 'POST' },
    { timeoutMs: 90_000 },
  );
  if (!retry.ok) return { ok: false as const, error: formatHttpError(retry) };
  return { ...(retry.json ?? { ok: false as const, error: 'bad json' }), resolvedId: String(match.id), resolvedCode: String(match.code) };
}

export async function adminResyncAllMasterdata(db: BetterSQLite3Database, apiBaseUrl: string) {
  const r = await httpAuthedWithGatewayRetry(
    db,
    apiBaseUrl,
    '/admin/masterdata/sync-snapshot/all',
    { method: 'POST' },
    { timeoutMs: 120_000 },
  );
  if (!r.ok) return { ok: false as const, error: formatHttpError(r) };
  return r.json ?? { ok: false as const, error: 'bad json' };
}
