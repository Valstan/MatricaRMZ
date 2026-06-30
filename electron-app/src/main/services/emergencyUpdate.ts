// Minimal self-contained installer fetch + launch, used ONLY when SQLite
// self-heal looped (same migration failed twice). The full updateService is
// not usable in this state — it relies on the local SQLite for settings,
// pending-update bookkeeping, and torrent peers, all of which require a
// working DB. This helper avoids all of that and uses only Node and Electron
// shell/app primitives to fetch the latest installer over plain HTTP and hand
// it off to the OS.

import { app, shell } from 'electron';
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type EmergencyUpdateResult =
  | { launched: true; version: string; installerPath: string }
  | { launched: false; reason: string };

type LatestMeta = {
  version: string;
  fileName: string;
  size: number;
};

const META_FETCH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  return `${b}/${p}`;
}

function parseSemver(v: string): number[] | null {
  const m = String(v).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchLatestMeta(apiBaseUrl: string): Promise<LatestMeta | null> {
  try {
    const url = joinUrl(apiBaseUrl, '/updates/latest-meta');
    const res = await fetchWithTimeout(url, META_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as unknown;
    if (!json || typeof json !== 'object') return null;
    const obj = json as Record<string, unknown>;
    if (obj.ok !== true) return null;
    const version = String(obj.version ?? '').trim();
    const fileName = String(obj.fileName ?? '').trim();
    const size = Number(obj.size ?? 0);
    if (!version || !fileName || !Number.isFinite(size) || size <= 0) return null;
    return { version, fileName, size };
  } catch {
    return null;
  }
}

async function downloadInstaller(
  apiBaseUrl: string,
  meta: LatestMeta,
  destPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const url = joinUrl(apiBaseUrl, `/updates/file/${encodeURIComponent(meta.fileName)}`);
    const res = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} downloading installer` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength !== meta.size) {
      return { ok: false, reason: `installer size mismatch: got=${buf.byteLength} want=${meta.size}` };
    }
    await writeFile(destPath, buf);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `installer download failed: ${String(err)}` };
  }
}

async function launchInstaller(installerPath: string): Promise<boolean> {
  // electron-builder NSIS oneClick installer: launches without UAC when
  // perMachine=false, runs, and the parent app should already be quitting.
  // detached spawn so the installer survives our quit().
  try {
    const child = spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return true;
  } catch {
    // Fallback: ask the OS shell to open the file (Windows associates .exe).
    try {
      const errMsg = await shell.openPath(installerPath);
      return errMsg === '';
    } catch {
      return false;
    }
  }
}

/**
 * Attempt a one-shot installer fetch + launch as a last-resort recovery when
 * SQLite migrations are structurally broken on this client. Side effects:
 * downloads a file to %TEMP% and spawns the installer detached.
 *
 * Returns `launched: true` when the installer process started successfully;
 * the caller is expected to call `app.quit()` immediately after so the
 * installer can replace files.
 */
export async function tryEmergencyUpdate(opts: {
  apiBaseUrl: string;
  currentVersion: string;
  onLog?: (line: string) => void;
}): Promise<EmergencyUpdateResult> {
  const log = (line: string) => opts.onLog?.(`emergency-update: ${line}`);

  const apiBaseUrl = opts.apiBaseUrl.trim();
  if (!apiBaseUrl) {
    log('apiBaseUrl is empty, cannot recover');
    return { launched: false, reason: 'apiBaseUrl is empty' };
  }

  log(`fetching latest meta from ${apiBaseUrl}`);
  const meta = await fetchLatestMeta(apiBaseUrl);
  if (!meta) {
    log('latest-meta endpoint unreachable or returned invalid payload');
    return { launched: false, reason: 'failed to reach /updates/latest-meta' };
  }

  log(`server reports latest=${meta.version} fileName=${meta.fileName} size=${meta.size}`);

  if (compareSemver(meta.version, opts.currentVersion) <= 0) {
    log(`server has no newer version (${meta.version} <= current ${opts.currentVersion})`);
    return {
      launched: false,
      reason: `server has no newer version (${meta.version} <= current ${opts.currentVersion})`,
    };
  }

  const destPath = join(tmpdir(), `matricarmz-emergency-${meta.version}.exe`);
  log(`downloading installer to ${destPath}`);
  const downloaded = await downloadInstaller(apiBaseUrl, meta, destPath);
  if (!downloaded.ok) {
    log(`download failed: ${downloaded.reason}`);
    await unlink(destPath).catch(() => {});
    return { launched: false, reason: downloaded.reason };
  }

  log(`launching installer (detached)`);
  const launched = await launchInstaller(destPath);
  if (!launched) {
    log(`failed to spawn installer`);
    return { launched: false, reason: 'failed to spawn installer' };
  }

  log(`installer launched, caller should app.quit() now`);
  return { launched: true, version: meta.version, installerPath: destPath };
}

// Exposed for tests.
export const __test = { joinUrl, parseSemver, fetchLatestMeta };
// app is unused in the unit-testable parts; keeping the import as a
// reminder that this module is Electron-bound and must NOT be loaded in
// non-Electron contexts (e.g. pure node tooling).
void app;
