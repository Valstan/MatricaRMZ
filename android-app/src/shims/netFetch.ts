// Шим electron-app services/netFetch.ts для android-бандла (подставляется
// vite-плагином androidShims вместо оригинала: тот тянет electron.net и
// node:fs/stream). Экспортная поверхность идентична; downloadWithResume в
// рамке v1 не нужен (обновления — через APK, файлы скрыты) и честно отказывает.
import type { RetryOptions } from '../../../electron-app/src/main/services/netFetch.js';

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffMs(attempt: number, opts: RetryOptions) {
  const base = Math.max(200, opts.backoffMs ?? 600);
  const max = Math.max(base, opts.maxBackoffMs ?? 5000);
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  const jitter = Math.max(0, opts.jitterMs ?? 250);
  return exp + Math.floor(Math.random() * jitter);
}

export function isTransientNetworkError(e: unknown): boolean {
  if (!e) return false;
  const anyE = e as { code?: unknown; name?: unknown; message?: unknown };
  const code = anyE?.code ? String(anyE.code) : '';
  const name = anyE?.name ? String(anyE.name) : '';
  const message = anyE?.message ? String(anyE.message) : String(e);
  const lower = message.toLowerCase();
  if (code && RETRYABLE_CODES.has(code)) return true;
  if (name === 'AbortError') return true;
  // Браузерный fetch кидает TypeError('Failed to fetch' / 'Load failed') на сетевые сбои.
  if (name === 'TypeError' && (lower.includes('failed to fetch') || lower.includes('load failed'))) return true;
  return (
    lower.includes('timeout') ||
    lower.includes('no-progress') ||
    lower.includes('socket hang up') ||
    lower.includes('network') ||
    lower.includes('enotfound') ||
    lower.includes('econnreset')
  );
}

function isOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    if (!opts.allowOffline && !isOnline()) {
      throw new Error('offline');
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), opts.timeoutMs);
    try {
      const res = await globalThis.fetch(url, { ...init, signal: ac.signal });
      if (opts.retryOnStatuses && opts.retryOnStatuses.includes(res.status) && attempt < opts.attempts) {
        await sleep(getBackoffMs(attempt, opts));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (!isTransientNetworkError(e) || attempt >= opts.attempts) break;
      await sleep(getBackoffMs(attempt, opts));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

export async function downloadWithResume(
  _url: string,
  _outPath: string,
  _opts: RetryOptions,
): Promise<{ ok: false; error: string }> {
  return { ok: false, error: 'downloadWithResume недоступен в android-клиенте (вне рамки v1)' };
}
