import { net } from 'electron';
import { spawn } from 'node:child_process';
import { stat, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type RetryOptions = {
  attempts: number;
  timeoutMs: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
  retryOnStatuses?: number[];
  allowOffline?: boolean;
};

type DownloadOptions = RetryOptions & {
  onProgress?: (pct: number, transferred: number, total: number | null) => void;
  noProgressTimeoutMs?: number;
  useBitsOnWindows?: boolean;
  bitsTimeoutMs?: number;
};

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

function escapePowerShellString(value: string) {
  return value.replace(/"/g, '`"');
}

async function downloadWithBits(url: string, outPath: string, timeoutMs?: number): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') return { ok: false, error: 'bits unsupported' };
  const escapedUrl = escapePowerShellString(url);
  const escapedPath = escapePowerShellString(outPath);
  const cmd = [
    `$ProgressPreference='SilentlyContinue'`,
    `Start-BitsTransfer -Source "${escapedUrl}" -Destination "${escapedPath}" -TransferType Download -Priority Foreground -ErrorAction Stop`,
  ].join('; ');
  return await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      windowsHide: true,
      stdio: 'ignore',
    });
    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      resolve(ok ? { ok: true } : { ok: false, error: error ?? 'bits failed' });
    };
    const timer =
      timeoutMs && Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {
              // ignore
            }
            finish(false, 'bits timeout');
          }, Math.max(10_000, timeoutMs))
        : null;
    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      finish(false, String(err));
    });
    child.once('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        finish(true);
      } else {
        finish(false, `bits exit ${code ?? 'unknown'}`);
      }
    });
  });
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
  const anyE = e as any;
  const code = anyE?.code ? String(anyE.code) : '';
  const name = anyE?.name ? String(anyE.name) : '';
  const message = anyE?.message ? String(anyE.message) : String(e);
  if (code && RETRYABLE_CODES.has(code)) return true;
  if (name === 'AbortError') return true;
  return (
    message.includes('timeout') ||
    message.includes('no-progress') ||
    message.includes('socket hang up') ||
    message.includes('network') ||
    message.includes('ENOTFOUND') ||
    message.includes('ECONNRESET')
  );
}

export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    if (!opts.allowOffline && !net.isOnline()) {
      throw new Error('offline');
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), opts.timeoutMs);
    try {
      const res = await net.fetch(url, { ...init, signal: ac.signal as any });
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

function parseTotalBytes(res: Response, rangeStart: number) {
  const contentRange = res.headers.get('content-range') ?? '';
  const match = contentRange.match(/\/(\d+)$/);
  if (match) return Number(match[1]);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > 0) return rangeStart > 0 ? len + rangeStart : len;
  return null;
}

export async function downloadWithResume(url: string, outPath: string, opts: DownloadOptions) {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    if (!opts.allowOffline && !net.isOnline()) {
      throw new Error('offline');
    }
    const ac = new AbortController();
    let timeoutId: NodeJS.Timeout | null = null;
    let noProgressTimer: NodeJS.Timeout | null = null;
    const armTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => ac.abort(new Error('timeout')), opts.timeoutMs);
    };
    armTimeout();
    try {
      let existingSize = 0;
      const st = await stat(outPath).catch(() => null);
      if (st?.isFile()) existingSize = st.size;

      let lastProgressAt = Date.now();
      const noProgressMs = Math.max(
        10_000,
        Number.isFinite(opts.noProgressTimeoutMs)
          ? Math.max(5_000, Number(opts.noProgressTimeoutMs))
          : Math.min(60_000, Math.floor(opts.timeoutMs / 2)),
      );
      if (noProgressMs > 0) {
        noProgressTimer = setInterval(() => {
          if (Date.now() - lastProgressAt > noProgressMs) {
            ac.abort(new Error('no-progress-timeout'));
          }
        }, Math.min(5000, Math.max(1000, Math.floor(noProgressMs / 2))));
      }

      const headers = new Headers();
      if (existingSize > 0) headers.set('Range', `bytes=${existingSize}-`);
      const res = await net.fetch(url, { method: 'GET', headers, signal: ac.signal as any });
      if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);

      const isPartial = res.status === 206;
      const start = isPartial ? existingSize : 0;
      const total = parseTotalBytes(res, start);

      if (!isPartial && existingSize > 0) {
        await rename(outPath, `${outPath}.bak`).catch(() => {});
        existingSize = 0;
      }

      let transferred = start;
      const stream = Readable.fromWeb(res.body as any);
      stream.on('data', (chunk) => {
        armTimeout();
        lastProgressAt = Date.now();
        const len = chunk?.length ?? 0;
        transferred += len;
        const pct = total ? Math.max(0, Math.min(99, Math.floor((transferred / total) * 100))) : 0;
        opts.onProgress?.(pct, transferred, total);
      });
      const out = createWriteStream(outPath, { flags: isPartial ? 'a' : 'w' });
      await pipeline(stream, out);
      opts.onProgress?.(100, transferred, total ?? transferred);
      return { ok: true as const, filePath: outPath };
    } catch (e) {
      lastErr = e;
      if (!isTransientNetworkError(e) || attempt >= opts.attempts) break;
      await sleep(getBackoffMs(attempt, opts));
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (noProgressTimer) clearInterval(noProgressTimer);
    }
  }
  if (opts.useBitsOnWindows && process.platform === 'win32') {
    const bits = await downloadWithBits(url, outPath, opts.bitsTimeoutMs ?? opts.timeoutMs);
    if (bits.ok) return { ok: true as const, filePath: outPath };
    return { ok: false as const, error: String(bits.error ?? lastErr ?? 'download failed') };
  }
  return { ok: false as const, error: String(lastErr ?? 'download failed') };
}
