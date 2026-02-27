import { app, BrowserWindow, dialog, shell } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, stat, writeFile, access, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { getNetworkState } from './networkService.js';
import { downloadWithResume, fetchWithRetry } from './netFetch.js';
import { getUpdatesRootDir } from './updatePaths.js';
import { SettingsKey, settingsGetString } from './settingsStore.js';
import {
  getLanServerPort,
  getLocalLanPeers,
  listLanPeers,
  listUpdatePeers,
  registerLanPeers,
  registerUpdatePeers,
  startLanUpdateServer,
} from './lanUpdateService.js';

export type UpdateCheckResult =
  | {
      ok: true;
      updateAvailable: boolean;
      version?: string;
      source?: 'github' | 'yandex' | 'lan' | 'torrent';
      downloadUrl?: string;
      expectedSize?: number | null;
    }
  | { ok: false; error: string };

export type UpdateFlowResult =
  | { action: 'no_update' }
  | { action: 'update_started' }
  | { action: 'update_downloaded'; version?: string; source?: 'github' | 'yandex' | 'lan' | 'torrent' }
  | { action: 'error'; error: string };

export type UpdateHelperArgs = {
  installerPath: string;
  launchPath: string;
  version?: string;
  parentPid?: number;
};

const UPDATE_CHECK_TIMEOUT_MS = 20_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const UPDATE_DOWNLOAD_NO_PROGRESS_MS = 45_000;
const UPDATE_BITS_TIMEOUT_MS = 12 * 60_000;

export function initAutoUpdate() {
  // kept for backward compatibility; no autoUpdater wiring needed
}

let updateInFlight = false;
let backgroundInFlight = false;
let updateUiWindow: BrowserWindow | null = null;
let updateUiLocked = false;
const updateLog: string[] = [];
let lastManualUpdatePromptAt = 0;
const MANUAL_UPDATE_PROMPT_COOLDOWN_MS = 30 * 60_000;

let updateApiBaseUrl = '';
let updateDb: BetterSQLite3Database | null = null;

type UpdateRuntimeState = {
  state: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error';
  source?: 'github' | 'yandex' | 'lan' | 'torrent';
  version?: string;
  progress?: number;
  message?: string;
  updatedAt: number;
};

let updateState: UpdateRuntimeState = { state: 'idle', updatedAt: Date.now() };

export function configureUpdateService(opts: { apiBaseUrl?: string; db?: BetterSQLite3Database }) {
  if (opts.apiBaseUrl) updateApiBaseUrl = String(opts.apiBaseUrl).trim();
  if (opts.db) updateDb = opts.db;
}

async function resolveUpdateApiBaseUrl(): Promise<string> {
  if (updateApiBaseUrl) return updateApiBaseUrl;
  if (updateDb) {
    try {
      const next = (await settingsGetString(updateDb, SettingsKey.ApiBaseUrl))?.trim() ?? '';
      if (next) updateApiBaseUrl = next;
    } catch {
      // ignore
    }
  }
  return updateApiBaseUrl;
}

async function openInstallerFolder(installerPath: string) {
  if (process.platform !== 'win32') return;
  try {
    shell.showItemInFolder(installerPath);
    await writeUpdaterLog(`installer folder opened: ${installerPath}`);
  } catch (e) {
    await writeUpdaterLog(`installer folder open failed: ${String(e)}`);
    const dir = dirname(installerPath);
    try {
      await shell.openPath(dir);
    } catch {
      // ignore
    }
  }
}

function updaterLogPath() {
  return join(app.getPath('userData'), 'matricarmz-updater.log');
}

function updateLockPath() {
  return join(getUpdatesRootDir(), 'update.lock');
}

async function acquireUpdateLock(tag: string): Promise<boolean> {
  const outDir = getUpdatesRootDir();
  await mkdir(outDir, { recursive: true });
  const lock = updateLockPath();
  try {
    const st = await stat(lock).catch(() => null);
    if (st?.isFile()) {
      const ageMs = Date.now() - Number(st.mtimeMs ?? 0);
      if (ageMs > 2 * 60 * 60 * 1000) {
        await rm(lock, { force: true }).catch(() => {});
      } else {
        return false;
      }
    }
    await writeFile(lock, JSON.stringify({ pid: process.pid, tag, ts: Date.now() }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function releaseUpdateLock() {
  await rm(updateLockPath(), { force: true }).catch(() => {});
}

async function writeUpdaterLog(message: string) {
  try {
    const ts = new Date().toISOString();
    await pruneLogFile(updaterLogPath(), 10);
    await appendFile(updaterLogPath(), `[${ts}] ${message}\n`, 'utf8');
  } catch {
    // ignore log write failures
  }
}

async function logLan(message: string) {
  await writeUpdaterLog(`lan-update: ${message}`);
}

async function logTorrent(message: string) {
  await writeUpdaterLog(`torrent-update: ${message}`);
}

function isPrivateIp(address: string): boolean {
  const ip = String(address ?? '').trim();
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (ip === '::1') return true;
  if (ip.startsWith('fe80:')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}

async function describePath(label: string, path: string) {
  try {
    const st = await stat(path).catch(() => null);
    if (!st) {
      await writeUpdaterLog(`path ${label}: missing (${path})`);
      return;
    }
    const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    await writeUpdaterLog(`path ${label}: ${kind} size=${st.size} (${path})`);
  } catch (e) {
    await writeUpdaterLog(`path ${label}: error ${String(e)} (${path})`);
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function pruneLogFile(path: string, maxDays: number) {
  try {
    const raw = await readFile(path, 'utf8');
    if (!raw.trim()) return;
    const cutoff = Date.now() - Math.max(1, maxDays) * 24 * 60 * 60 * 1000;
    const lines = raw.split('\n');
    const kept = lines.filter((line) => {
      const m = line.match(/^\[(.+?)\]/);
      if (!m) return true;
      const tsRaw = m[1];
      if (!tsRaw) return true;
      const ts = Date.parse(tsRaw);
      if (!Number.isFinite(ts)) return true;
      return ts >= cutoff;
    });
    const next = kept.join('\n').trimEnd();
    await writeFile(path, next ? `${next}\n` : '', 'utf8');
  } catch {
    // ignore prune errors
  }
}

function isSetupInstallerName(name: string) {
  return /(setup|installer)/i.test(name);
}

async function validateInstallerPath(
  installerPath: string,
  expectedName?: string,
  expectedSize?: number | null,
): Promise<{ ok: true; isSetup: boolean; size: number; actualName: string } | { ok: false; error: string }> {
  const st = await stat(installerPath).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, error: 'installer file is missing' };
  if (st.size <= 0) return { ok: false, error: 'installer file is empty' };
  if (expectedSize && Number.isFinite(expectedSize) && st.size !== expectedSize) {
    return { ok: false, error: `installer size mismatch: expected ${expectedSize} got ${st.size}` };
  }
  const actualName = basename(installerPath);
  const expected = expectedName ? basename(expectedName) : '';
  const expectedRequiresSetup = expected ? isSetupInstallerName(expected) : false;
  const actualIsSetup = isSetupInstallerName(actualName);
  if (expectedRequiresSetup && !actualIsSetup) {
    return { ok: false, error: `installer mismatch: expected setup, got ${actualName}` };
  }
  return { ok: true, isSetup: actualIsSetup, size: st.size, actualName };
}

type ServerUpdateMeta = {
  version: string;
  fileName: string;
  size: number;
  sha256?: string;
};

function joinUrl(base: string, path: string) {
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  const p = String(path ?? '').trim().replace(/^\/+/, '');
  return `${b}/${p}`;
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  return await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (buf) => hash.update(buf));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fetchLatestUpdateMetaFromServer(): Promise<ServerUpdateMeta | null> {
  const apiBaseUrl = await resolveUpdateApiBaseUrl();
  if (!apiBaseUrl) return null;
  try {
    const url = joinUrl(apiBaseUrl, '/updates/latest-meta');
    const res = await fetchWithRetry(
      url,
      { method: 'GET' },
      { attempts: 3, timeoutMs: 8000, backoffMs: 600, maxBackoffMs: 3000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
    );
    if (!res.ok) {
      await logLan(`server meta HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json().catch(() => null)) as any;
    if (!json?.ok) return null;
    const version = String(json.version ?? '').trim();
    const fileName = String(json.fileName ?? '').trim();
    const size = Number(json.size ?? 0);
    const sha256 = String(json.sha256 ?? '').trim();
    if (!version || !fileName || !Number.isFinite(size) || size <= 0) return null;
    return { version, fileName, size, ...(sha256 ? { sha256 } : {}) };
  } catch {
    return null;
  }
}

async function findCachedInstallerForVersion(
  version: string,
  expectedName?: string,
): Promise<{ filePath: string; fileName: string } | null> {
  const dir = join(getUpdatesRootDir(), version);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  if (files.length === 0) return null;
  if (expectedName && files.includes(expectedName)) {
    return { filePath: join(dir, expectedName), fileName: expectedName };
  }
  const exe = files.find((f) => f.toLowerCase().endsWith('.exe'));
  if (!exe) return null;
  return { filePath: join(dir, exe), fileName: exe };
}

async function validateInstallerIntegrity(
  installerPath: string,
  expectedName: string,
  expectedSize: number,
  expectedSha?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const basic = await validateInstallerPath(installerPath, expectedName, expectedSize);
  if (!basic.ok) return basic;
  if (expectedSha) {
    const actual = await computeSha256(installerPath);
    if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
      return { ok: false, error: 'installer sha256 mismatch' };
    }
  }
  return { ok: true };
}

async function queuePendingUpdate(args: {
  version: string;
  installerPath: string;
  expectedName?: string;
  expectedSize?: number | null;
  downloadUrl?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const validation = await validateInstallerPath(args.installerPath, args.expectedName, args.expectedSize ?? null);
  if (!validation.ok) return validation;
  await writePendingUpdate({
    version: args.version,
    installerPath: args.installerPath,
    expectedSize: args.expectedSize ?? null,
    downloadUrl: args.downloadUrl ?? null,
  });
  await writeUpdaterLog(
    `pending-update saved version=${args.version} installer=${args.installerPath} size=${validation.size}`,
  );
  return { ok: true };
}

async function installNow(args: { installerPath: string; version?: string }) {
  await stageUpdate('Скачивание завершено. Готовим установку…', 60, args.version);
  lockUpdateUi(true);
  await stageUpdate('Подготовка установщика…', 70, args.version);
  const validation = await validateInstallerPath(args.installerPath, args.installerPath);
  if (!validation.ok) {
    await writeUpdaterLog(`installer validation failed: ${validation.error}`);
    await stageUpdate('Установщик поврежден. Повторим позже.', 100, args.version);
    await writePendingUpdate({ version: args.version ?? 'unknown', installerPath: args.installerPath });
    closeUpdateWindowSoon(4000);
    return;
  }
  const helper = await prepareUpdateHelper();
  await writeUpdaterLog(`update-helper spawn version=${args.version ?? 'unknown'} installer=${args.installerPath}`);
  const spawned = await spawnUpdateHelper({
    helperExePath: helper.helperExePath,
    installerPath: args.installerPath,
    launchPath: helper.launchPath,
    resourcesPath: helper.resourcesPath,
    ...(args.version ? { version: args.version } : {}),
    parentPid: process.pid,
  });
  if (!spawned) {
    await writeUpdaterLog('update-helper spawn failed, keeping pending update');
    await openInstallerFolder(args.installerPath);
    await writePendingUpdate({ version: args.version ?? 'unknown', installerPath: args.installerPath });
    await stageUpdate('Не удалось запустить установщик. Повторим при следующем запуске.', 100, args.version);
    closeUpdateWindowSoon(4000);
    return;
  }
  await stageUpdate('Запускаем установку…', 80, args.version);
  quitMainAppSoon();
}

async function renderUpdateLog() {
  const w = updateUiWindow;
  if (!w || w.isDestroyed()) return;
  const items = updateLog.map((line) => `<div class="log-item">${escapeHtml(line)}</div>`).join('');
  const safe = items.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const js = `document.getElementById('log').innerHTML='${safe}';`;
  await w.webContents.executeJavaScript(js, true).catch(() => {});
  const lineCount = Math.min(updateLog.length, 18);
  const baseHeight = 220;
  const lineHeight = 18;
  const targetHeight = Math.min(720, Math.max(320, baseHeight + lineCount * lineHeight));
  try {
    const [curW, curH] = w.getSize();
    if (curH != null && targetHeight > curH) w.setSize(Math.max(curW ?? 640, 640), targetHeight);
  } catch {
    // ignore resize errors
  }
}

async function addUpdateLog(line: string) {
  updateLog.push(line);
  while (updateLog.length > 18) updateLog.shift();
  await renderUpdateLog();
}

function setUpdateState(next: Partial<UpdateRuntimeState>) {
  updateState = {
    ...updateState,
    ...next,
    updatedAt: Date.now(),
  };
}

export function getUpdateState(): UpdateRuntimeState {
  return updateState;
}

function showUpdateWindow(parent?: BrowserWindow | null) {
  if (updateUiWindow && !updateUiWindow.isDestroyed()) return updateUiWindow;
  updateLog.length = 0;
  updateUiWindow = new BrowserWindow({
    width: 640,
    height: 360,
    minWidth: 520,
    minHeight: 320,
    modal: !!parent,
    ...(parent ? { parent } : {}),
    title: `Обновление MatricaRMZ`,
    resizable: true,
    minimizable: false,
    maximizable: true,
    alwaysOnTop: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  updateUiWindow.setMenuBarVisibility(false);
  updateUiWindow.on('close', (e) => {
    if (updateUiLocked) e.preventDefault();
  });

  const html = `<!doctype html>
  <html><head><meta charset="utf-8"/><title>Update</title>
  <style>
    body{font-family:system-ui; padding:16px;}
    .muted{color:#6b7280}
    .bar{height:10px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin-top:10px}
    .fill{height:10px;background:#0f172a;width:0%}
    .row{display:flex;gap:8px;align-items:center;margin-top:8px}
    .pct{font-variant-numeric:tabular-nums}
    .log{margin-top:10px; font-size:12px; color:#4b5563}
    .log-item{margin-top:4px}
  </style></head>
  <body>
    <h2 style="margin:0">Обновление</h2>
    <div id="msg" class="muted" style="margin-top:8px">Проверяем обновления…</div>
    <div class="row"><div class="pct" id="pct">0%</div><div class="muted" id="ver"></div></div>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div id="log" class="log"></div>
  </body></html>`;
  void updateUiWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return updateUiWindow;
}

function lockUpdateUi(locked: boolean) {
  updateUiLocked = locked;
  if (updateUiWindow && !updateUiWindow.isDestroyed()) {
    try {
      updateUiWindow.setClosable(!locked);
    } catch {
      // ignore
    }
  }
}

function closeUpdateWindowSoon(ms = 500) {
  lockUpdateUi(false);
  setTimeout(() => {
    updateUiWindow?.close();
    updateUiWindow = null;
  }, ms);
}

function quitMainAppSoon(ms = 800) {
  setTimeout(() => {
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          w.destroy();
        } catch {
          // ignore
        }
      }
      app.quit();
    } catch {
      // ignore
    }
  }, ms);
  setTimeout(() => {
    try {
      app.exit(0);
    } catch {
      // ignore
    }
  }, Math.max(ms + 8000, 10000));
}

async function setUpdateUi(msg: string, pct?: number, version?: string) {
  const w = updateUiWindow;
  if (!w || w.isDestroyed()) return;
  const safeMsg = msg.replace(/'/g, "\\'");
  const p = pct == null ? null : Math.max(0, Math.min(100, Math.floor(pct)));
  const safeVer = (version ?? '').replace(/'/g, "\\'");
  const js = `
    document.getElementById('msg').innerText='${safeMsg}';
    ${p == null ? '' : `document.getElementById('pct').innerText='${p}%'; document.getElementById('fill').style.width='${p}%';`}
    document.getElementById('ver').innerText='${safeVer ? 'Новая версия: ' + safeVer : ''}';
  `;
  await w.webContents.executeJavaScript(js, true).catch(() => {});
}

async function stageUpdate(msg: string, pct?: number, version?: string) {
  await addUpdateLog(msg);
  await setUpdateUi(msg, pct, version);
}

async function cacheInstaller(filePath: string, version?: string) {
  const ver = version?.trim() || 'latest';
  const outDir = join(getUpdatesRootDir(), ver);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, basename(filePath));
  if (outPath === filePath) return outPath;
  await copyFile(filePath, outPath).catch(() => {});
  return outPath;
}

export async function recoverStuckUpdateState(): Promise<void> {
  if (updateInFlight || backgroundInFlight) return;
  const lock = updateLockPath();
  const lockStat = await stat(lock).catch(() => null);
  if (!lockStat?.isFile()) return;
  const current = app.getVersion();
  const pending = await readPendingUpdate();
  let keepCache = false;
  if (pending?.installerPath) {
    const validation = await validateInstallerPath(pending.installerPath, pending.installerPath);
    if (!validation.ok || (pending.version && compareSemver(pending.version, current) <= 0)) {
      await writeUpdaterLog(`stale update cleared: ${validation.ok ? 'version <= current' : validation.error}`);
      await clearPendingUpdate();
    } else {
      keepCache = true;
    }
  }
  if (!keepCache) {
    await cleanupUpdateCache(current);
  }
  await releaseUpdateLock();
  await writeUpdaterLog('stale update lock removed, update flow reset');
}

export async function resetUpdateCache(reason = 'manual'): Promise<void> {
  try {
    updateInFlight = false;
    backgroundInFlight = false;
    await clearPendingUpdate();
    await releaseUpdateLock();
    const updatesDir = getUpdatesRootDir();
    const entries = await readdir(updatesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = join(updatesDir, entry.name);
      await rm(entryPath, { recursive: true, force: true }).catch(() => {});
    }
    setUpdateState({ state: 'idle', message: 'Кэш обновлений очищен.' });
    await writeUpdaterLog(`update cache reset (${reason})`);
  } catch (e) {
    await writeUpdaterLog(`update cache reset failed: ${String(e)}`);
  }
}

async function cleanupUpdateCache(keepVersion: string) {
  const updatesDir = getUpdatesRootDir();
  const entries = await readdir(updatesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = join(updatesDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== keepVersion) {
        await rm(entryPath, { recursive: true, force: true }).catch(() => {});
      }
      continue;
    }
    if (entry.isFile()) {
      if (entry.name === 'pending-update.json') {
        const pending = await readPendingUpdate();
        if (pending?.version && pending.version !== keepVersion) {
          await clearPendingUpdate();
        }
        continue;
      }
      await rm(entryPath, { force: true }).catch(() => {});
    }
  }
}

function pendingUpdatePath() {
  return join(getUpdatesRootDir(), 'pending-update.json');
}

async function writePendingUpdate(data: {
  version: string;
  installerPath: string;
  expectedSize?: number | null;
  downloadUrl?: string | null;
}) {
  const outDir = getUpdatesRootDir();
  await mkdir(outDir, { recursive: true });
  await writeFile(pendingUpdatePath(), JSON.stringify(data, null, 2), 'utf8');
}

async function readPendingUpdate(): Promise<{
  version: string;
  installerPath: string;
  expectedSize?: number | null;
  downloadUrl?: string | null;
} | null> {
  try {
    const raw = await readFile(pendingUpdatePath(), 'utf8');
    const json = JSON.parse(raw) as any;
    if (!json?.version || !json?.installerPath) return null;
    return {
      version: String(json.version),
      installerPath: String(json.installerPath),
      expectedSize: json.expectedSize != null ? Number(json.expectedSize) : null,
      downloadUrl: typeof json.downloadUrl === 'string' ? String(json.downloadUrl) : null,
    };
  } catch {
    return null;
  }
}

async function clearPendingUpdate() {
  try {
    await writeFile(pendingUpdatePath(), '', 'utf8');
  } catch {
    // ignore
  }
}

async function findCachedInstaller(): Promise<{ version: string; installerPath: string } | null> {
  const root = getUpdatesRootDir();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const versions = entries
    .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
    .map((e) => e.name);
  if (versions.length === 0) return null;
  versions.sort((a, b) => compareSemver(b, a));
  for (const ver of versions) {
    const dir = join(root, ver);
    const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const candidates = files.filter((f) => f.isFile() && f.name.toLowerCase().endsWith('.exe')).map((f) => f.name);
    if (candidates.length === 0) continue;
    const preferred = candidates.find((n) => isSetupInstallerName(n)) ?? candidates[0];
    const installerPath = join(dir, preferred ?? '');
    const validation = await validateInstallerPath(installerPath, preferred);
    if (!validation.ok) continue;
    return { version: ver, installerPath };
  }
  return null;
}

async function resolveLocalInstaller(currentVersion: string, serverVersion: string | null) {
  const pending = await readPendingUpdate();
  if (pending?.version && compareSemver(pending.version, currentVersion) > 0) {
    const validation = await validateInstallerPath(pending.installerPath, pending.installerPath, pending.expectedSize ?? null);
    if (!validation.ok) {
      await clearPendingUpdate();
    } else if (!serverVersion || compareSemver(pending.version, serverVersion) >= 0) {
      return { action: 'install' as const, version: pending.version, installerPath: pending.installerPath };
    }
  }

  const cached = await findCachedInstaller();
  if (cached && compareSemver(cached.version, currentVersion) > 0) {
    if (!serverVersion || compareSemver(cached.version, serverVersion) >= 0) {
      await queuePendingUpdate({ version: cached.version, installerPath: cached.installerPath });
      return { action: 'install' as const, version: cached.version, installerPath: cached.installerPath };
    }
  }

  return { action: 'none' as const };
}

async function getServerVersion(): Promise<string | null> {
  try {
    const t = await fetchLatestTorrentFromServer();
    if (t.ok && t.version) return t.version;
    const y = await checkYandexForUpdates();
    if (y.ok && y.version) return y.version;
    const gh = await checkGithubReleaseForUpdates();
    if (gh.ok && gh.version) return gh.version;
  } catch {
    // ignore
  }
  return null;
}

async function fetchLatestTorrentFromServer(): Promise<TorrentLatestInfo> {
  const apiBaseUrl = await resolveUpdateApiBaseUrl();
  if (!apiBaseUrl) return { ok: false, error: 'apiBaseUrl missing' };
  try {
    const url = joinUrl(apiBaseUrl, '/updates/latest');
    const res = await fetchWithRetry(
      url,
      { method: 'GET' },
      { attempts: 3, timeoutMs: 8000, backoffMs: 600, maxBackoffMs: 3000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
    );
    if (!res.ok) return { ok: false, error: `torrent latest HTTP ${res.status}` };
    const json = (await res.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false, error: String(json?.error ?? 'torrent latest unavailable') };
    const version = String(json?.version ?? '').trim();
    const fileName = String(json?.fileName ?? '').trim();
    const infoHash = String(json?.infoHash ?? '').trim();
    const size = Number(json?.size ?? 0);
    if (!version || !fileName || !infoHash || !Number.isFinite(size) || size <= 0) {
      return { ok: false, error: 'torrent latest invalid payload' };
    }
    const current = app.getVersion();
    const updateAvailable = compareSemver(version, current) > 0;
    return {
      ok: true,
      updateAvailable,
      version,
      fileName,
      size,
      infoHash,
      ...(typeof json?.torrentUrl === 'string' ? { torrentUrl: String(json.torrentUrl) } : {}),
      source: 'torrent',
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function tryDownloadFromTorrentPeers(
  meta: { version: string; fileName: string; size: number; infoHash: string; sha256?: string },
  opts?: {
    localOnly?: boolean;
    includeServerWebSeed?: boolean;
    onProgress?: (pct: number, transferred: number, total: number | null) => void;
  },
): Promise<{ ok: true; filePath: string; downloadUrl: string } | { ok: false; error: string }> {
  const apiBaseUrl = await resolveUpdateApiBaseUrl();
  if (!apiBaseUrl) return { ok: false as const, error: 'apiBaseUrl missing' };

  const serverPort = getLanServerPort() ?? undefined;
  const selfPeers = getLocalLanPeers(serverPort ?? 0);
  const excludeIp = selfPeers[0]?.ip;
  const peers = await listUpdatePeers(
    apiBaseUrl,
    meta.infoHash,
    excludeIp ? { ip: excludeIp, ...(serverPort != null ? { port: serverPort } : {}) } : undefined,
  );
  const selectedPeers = (opts?.localOnly ? peers.filter((p) => isPrivateIp(String(p.ip ?? ''))) : peers).filter((p) => p.ip);
  await logTorrent(
    `peer list mode=${opts?.localOnly ? 'local' : 'any'} peers=${selectedPeers.length} version=${meta.version} infoHash=${meta.infoHash}`,
  );

  const fallbackPortRaw = Number(process.env.MATRICA_UPDATE_PEER_HTTP_PORT ?? 3001);
  const fallbackPort = Number.isFinite(fallbackPortRaw) && fallbackPortRaw > 0 ? Math.floor(fallbackPortRaw) : 3001;
  const candidates: string[] = [];
  for (const peer of selectedPeers) {
    const ip = String(peer.ip ?? '').trim();
    if (!ip) continue;
    const ports = new Set<number>();
    const reported = Number(peer.port ?? 0);
    if (Number.isFinite(reported) && reported > 0) ports.add(Math.floor(reported));
    ports.add(fallbackPort);
    for (const port of ports) {
      candidates.push(`http://${ip}:${port}/updates/file/${encodeURIComponent(meta.fileName)}`);
    }
  }
  if (opts?.includeServerWebSeed) {
    candidates.push(joinUrl(apiBaseUrl, `/updates/file/${encodeURIComponent(meta.fileName)}`));
  }
  const uniqCandidates = Array.from(new Set(candidates));
  if (!uniqCandidates.length) return { ok: false as const, error: 'no peer download candidates' };

  const outDir = getUpdateDownloadDir(meta.version, meta.fileName);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, meta.fileName);

  for (const url of uniqCandidates) {
    await logTorrent(`download try url=${url}`);
    const dl = await downloadWithResume(url, outPath, {
      attempts: 2,
      timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
      noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
      useBitsOnWindows: false,
      backoffMs: 800,
      maxBackoffMs: 6000,
      jitterMs: 300,
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    if (!dl.ok || !dl.filePath) {
      await logTorrent(`download failed url=${url} error=${dl.error ?? 'unknown'}`);
      continue;
    }
    const integrity = await validateInstallerIntegrity(outPath, meta.fileName, meta.size, meta.sha256);
    if (!integrity.ok) {
      await logTorrent(`integrity failed url=${url} error=${integrity.error}`);
      await rm(outPath, { force: true }).catch(() => {});
      continue;
    }
    await logTorrent(`download ok url=${url}`);
    return { ok: true as const, filePath: outPath, downloadUrl: url };
  }
  return { ok: false as const, error: 'torrent peer download failed' };
}

async function promptManualUpdateFallback(args: {
  version?: string;
  yandexUrl?: string | null;
  reason?: string;
}): Promise<'close' | 'run'> {
  const yandexUrl = args.yandexUrl ? String(args.yandexUrl).trim() : '';
  const message = yandexUrl
    ? 'Автообновление не удалось. Установите обновление вручную по ссылке Яндекс.Диска.'
    : 'Автообновление не удалось. Установите обновление вручную из источника обновлений.';
  const details = [
    args.version ? `Версия: ${args.version}` : '',
    args.reason ? `Причина: ${args.reason}` : '',
    yandexUrl ? `Ссылка: ${yandexUrl}` : '',
    '',
    'Что делать:',
    '1) Откройте ссылку и скачайте установщик .exe.',
    '2) Запустите установщик и завершите установку.',
    '3) После этого выберите действие ниже.',
  ]
    .filter(Boolean)
    .join('\n');

  await stageUpdate(message, 100, args.version);
  lockUpdateUi(false);
  const response = updateUiWindow
    ? await dialog.showMessageBox(updateUiWindow, {
        type: 'warning',
        title: 'Ручное обновление',
        message,
        detail: details,
        buttons: ['Закрыть программу', 'Запустить программу'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
    : await dialog.showMessageBox({
        type: 'warning',
        title: 'Ручное обновление',
        message,
        detail: details,
        buttons: ['Закрыть программу', 'Запустить программу'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
  return response.response === 0 ? 'close' : 'run';
}

export async function applyPendingUpdateIfAny(parentWindow?: BrowserWindow | null): Promise<boolean> {
  const pending = await readPendingUpdate();
  if (!pending?.installerPath) return false;
  const currentVersion = app.getVersion();
  if (pending.version && compareSemver(pending.version, currentVersion) <= 0) {
    await writeUpdaterLog(`pending-update ignored: version=${pending.version} current=${currentVersion}`);
    await clearPendingUpdate();
    return false;
  }
  if (pending.version) {
    try {
      const latest = await getServerVersion();
      if (latest && compareSemver(latest, pending.version) > 0) {
        await writeUpdaterLog(
          `pending-update superseded by server: pending=${pending.version} latest=${latest}`,
        );
        await clearPendingUpdate();
        return false;
      }
    } catch (e) {
      await writeUpdaterLog(`pending-update server check failed: ${String(e)}`);
    }
  }
  try {
    await access(pending.installerPath);
  } catch {
    await writeUpdaterLog(`pending-update missing installer: ${pending.installerPath}`);
    await clearPendingUpdate();
    return false;
  }
  if (pending.expectedSize && Number.isFinite(pending.expectedSize)) {
    const validation = await validateInstallerPath(pending.installerPath, pending.installerPath, pending.expectedSize ?? null);
    if (!validation.ok) {
      await writeUpdaterLog(`pending-update integrity failed: ${validation.error}`);
      if (pending.downloadUrl) {
        await writeUpdaterLog(`pending-update re-download start url=${pending.downloadUrl}`);
        const redl = await downloadWithResume(pending.downloadUrl, pending.installerPath, {
          attempts: 3,
          timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
          noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
          useBitsOnWindows: true,
          bitsTimeoutMs: UPDATE_BITS_TIMEOUT_MS,
          backoffMs: 800,
          maxBackoffMs: 6000,
          jitterMs: 300,
        });
        if (!redl.ok || !redl.filePath) {
          await writeUpdaterLog(`pending-update re-download failed: ${redl.error ?? 'download failed'}`);
          await rm(pending.installerPath, { force: true }).catch(() => {});
          await clearPendingUpdate();
          return false;
        }
        const recheck = await validateInstallerPath(pending.installerPath, pending.installerPath, pending.expectedSize ?? null);
        if (!recheck.ok) {
          await writeUpdaterLog(`pending-update integrity still failed: ${recheck.error}`);
          await rm(pending.installerPath, { force: true }).catch(() => {});
          await clearPendingUpdate();
          return false;
        }
      } else {
        await rm(pending.installerPath, { force: true }).catch(() => {});
        await clearPendingUpdate();
        return false;
      }
    }
  }
  showUpdateWindow(parentWindow ?? null);
  lockUpdateUi(true);
  await setUpdateUi('Найдена скачанная версия. Устанавливаем…', 80, pending.version);
  await writeUpdaterLog(`update-helper start version=${pending.version} installer=${pending.installerPath}`);
  await describePath('pending-installer', pending.installerPath);
  await writeUpdaterLog('pending-update will be cleared after helper spawn');
  await addUpdateLog(`update helper: resolving resources path`);
  const helper = await prepareUpdateHelper();
  await addUpdateLog(`update helper: resources=${helper.resourcesPath}`);
  await writeUpdaterLog(`update-helper resources=${helper.resourcesPath} launch=${helper.launchPath}`);
  await describePath('helper-exe', helper.helperExePath);
  await describePath('helper-launch', helper.launchPath);
  await describePath('helper-resources', helper.resourcesPath);
  const spawned = await spawnUpdateHelper({
    helperExePath: helper.helperExePath,
    installerPath: pending.installerPath,
    launchPath: helper.launchPath,
    resourcesPath: helper.resourcesPath,
    version: pending.version,
  });
  if (!spawned) {
    await writeUpdaterLog('update-helper spawn failed, pending update retained');
    await setUpdateUi('Ошибка запуска установщика. Повторим при следующем запуске.', 100, pending.version);
    closeUpdateWindowSoon(4000);
    return false;
  }
  await writeUpdaterLog('pending-update cleared after helper spawn');
  await clearPendingUpdate();
  quitMainAppSoon();
  return true;
}

export function startBackgroundUpdatePolling(opts: { intervalMs?: number } = {}) {
  const intervalMs = Math.max(5 * 60_000, opts.intervalMs ?? 5 * 60_000);
  setTimeout(() => void tick(), 90_000);
  setInterval(() => void tick(), intervalMs);

  async function tryYandexDownload(): Promise<{ ok: true; installerPath: string; version: string } | { ok: false; error: string; version?: string } | null> {
    setUpdateState({ state: 'checking', source: 'yandex', message: 'Проверяем обновления (Yandex)…' });
    const y = await checkYandexForUpdates();
    if (!y.ok || !y.updateAvailable || !y.version) return null;
    const version = y.version;
    await cleanupUpdateCache(version);
    setUpdateState({
      state: 'downloading',
      source: 'yandex',
      version,
      progress: 0,
      message: 'Скачиваем обновление (Yandex)…',
    });
    const yPath = 'path' in y ? y.path : undefined;
    const ydl = await downloadYandexUpdate(
      {
        version: y.version,
        ...(yPath ? { path: yPath } : {}),
        ...(y.downloadUrl ? { downloadUrl: y.downloadUrl } : {}),
      },
      {
      onProgress: (pct) => {
        setUpdateState({
          state: 'downloading',
          source: 'yandex',
          version,
          progress: Math.max(0, Math.min(100, pct)),
          message: 'Скачиваем обновление (Yandex)…',
        });
      },
      },
    );
    if (!ydl.ok || !ydl.filePath) {
      setUpdateState({ state: 'error', source: 'yandex', version, message: ydl.error ?? 'download failed' });
      return { ok: false, error: ydl.error ?? 'download failed', version };
    }
    const cachedPath = await cacheInstaller(ydl.filePath, version);
    const queued = await queuePendingUpdate({
      version,
      installerPath: cachedPath,
      expectedSize: y.expectedSize ?? null,
      downloadUrl: y.downloadUrl ?? null,
    });
    if (!queued.ok) {
      setUpdateState({ state: 'error', source: 'yandex', version, message: queued.error });
      return { ok: false, error: queued.error, version };
    }
    setUpdateState({
      state: 'downloaded',
      source: 'yandex',
      version,
      progress: 100,
      message: 'Обновление скачано. Запускаем установку…',
    });
    return { ok: true, installerPath: cachedPath, version };
  }

  async function tryGithubDownload(): Promise<{ ok: true; installerPath: string; version: string } | { ok: false; error: string; version?: string } | null> {
    setUpdateState({ state: 'checking', source: 'github', message: 'Проверяем обновления (GitHub)…' });
    const gh = await checkGithubReleaseForUpdates();
    if (!gh.ok || !gh.updateAvailable || !gh.downloadUrl || !gh.version) return null;
    const version = gh.version;
    await cleanupUpdateCache(version);
    setUpdateState({
      state: 'downloading',
      source: 'github',
      version,
      progress: 0,
      message: 'Скачиваем обновление (GitHub)…',
    });
    const gdl = await downloadGithubUpdate(gh.downloadUrl, version, {
      onProgress: (pct) => {
        setUpdateState({
          state: 'downloading',
          source: 'github',
          version,
          progress: Math.max(0, Math.min(100, pct)),
          message: 'Скачиваем обновление (GitHub)…',
        });
      },
    });
    if (!gdl.ok || !gdl.filePath) {
      setUpdateState({ state: 'error', source: 'github', version, message: gdl.error ?? 'download failed' });
      return { ok: false, error: gdl.error ?? 'download failed', version };
    }
    const cachedPath = await cacheInstaller(gdl.filePath, version);
    const queued = await queuePendingUpdate({
      version,
      installerPath: cachedPath,
      expectedSize: gh.expectedSize ?? null,
      downloadUrl: gh.downloadUrl ?? null,
    });
    if (!queued.ok) {
      setUpdateState({ state: 'error', source: 'github', version, message: queued.error });
      return { ok: false, error: queued.error, version };
    }
    setUpdateState({
      state: 'downloaded',
      source: 'github',
      version,
      progress: 100,
      message: 'Обновление скачано. Запускаем установку…',
    });
    return { ok: true, installerPath: cachedPath, version };
  }

  async function tick() {
    if (updateInFlight || backgroundInFlight) return;
    const pending = await readPendingUpdate();
    if (!app.isPackaged) return;
    backgroundInFlight = true;
    let lockAcquired = await acquireUpdateLock('background');
    let lockReleased = false;
    if (!lockAcquired) {
      backgroundInFlight = false;
      return;
    }
    try {
      const netState = getNetworkState();
      if (!netState.online) {
        setUpdateState({ state: 'error', source: 'yandex', message: 'Нет сети, повторим позже.' });
        return;
      }
      const current = app.getVersion();
      let candidateVersion: string | undefined;
      let candidateReason: string | undefined;

      if (pending?.version && compareSemver(pending.version, current) > 0) {
        setUpdateState({
          state: 'downloaded',
          source: 'yandex',
          version: pending.version,
          progress: 100,
          message: 'Обновление скачано. Установится после перезапуска.',
        });
        return;
      }

      const serverMeta = await fetchLatestUpdateMetaFromServer();
      const torrentLatest = await fetchLatestTorrentFromServer();
      const torrentMeta =
        torrentLatest.ok &&
        torrentLatest.updateAvailable &&
        torrentLatest.version &&
        torrentLatest.fileName &&
        torrentLatest.infoHash &&
        Number.isFinite(Number(torrentLatest.size ?? 0)) &&
        Number(torrentLatest.size ?? 0) > 0
          ? {
              version: torrentLatest.version,
              fileName: torrentLatest.fileName,
              size: Number(torrentLatest.size),
              infoHash: torrentLatest.infoHash,
              ...(serverMeta && serverMeta.version === torrentLatest.version && serverMeta.fileName === torrentLatest.fileName && serverMeta.sha256
                ? { sha256: serverMeta.sha256 }
                : {}),
            }
          : null;

      if (serverMeta && compareSemver(serverMeta.version, current) <= 0) {
        void tryAdvertiseLan(serverMeta).catch(() => {});
      }

      // 1) Торрент-пиры локальные (из /updates/peers)
      if (torrentMeta && compareSemver(torrentMeta.version, current) > 0) {
        candidateVersion = torrentMeta.version;
        candidateReason = 'torrent local peers failed';
        setUpdateState({
          state: 'downloading',
          source: 'torrent',
          version: torrentMeta.version,
          progress: 0,
          message: 'Скачиваем обновление (торрент-пиры, локальные)…',
        });
        const tLocal = await tryDownloadFromTorrentPeers(torrentMeta, { localOnly: true });
        if (tLocal.ok) {
          const cachedPath = await cacheInstaller(tLocal.filePath, torrentMeta.version);
          const queued = await queuePendingUpdate({
            version: torrentMeta.version,
            installerPath: cachedPath,
            expectedName: torrentMeta.fileName,
            expectedSize: torrentMeta.size,
            downloadUrl: tLocal.downloadUrl,
          });
          if (queued.ok) {
            await releaseUpdateLock();
            lockReleased = true;
            backgroundInFlight = false;
            showUpdateWindow(null);
            await installNow({ installerPath: cachedPath, version: torrentMeta.version });
            return;
          }
        }
      }

      // 2) Локальная LAN-раздача (HTTP peers /updates/lan/peers)
      if (serverMeta && compareSemver(serverMeta.version, current) > 0) {
        candidateVersion = candidateVersion ?? serverMeta.version;
        candidateReason = candidateReason ?? 'lan peers failed';
        setUpdateState({
          state: 'downloading',
          source: 'lan',
          version: serverMeta.version,
          progress: 0,
          message: 'Скачиваем обновление (Локальная сеть)…',
        });
        const lan = await tryDownloadFromLan(serverMeta, {
          onProgress: (pct) => {
            setUpdateState({
              state: 'downloading',
              source: 'lan',
              version: serverMeta.version,
              progress: Math.max(0, Math.min(100, pct)),
              message: 'Скачиваем обновление (Локальная сеть)…',
            });
          },
        });
        if (lan.ok) {
          const cachedPath = await cacheInstaller(lan.filePath, serverMeta.version);
          const queued = await queuePendingUpdate({
            version: serverMeta.version,
            installerPath: cachedPath,
            expectedName: serverMeta.fileName,
            expectedSize: serverMeta.size,
            downloadUrl: `lan://${serverMeta.fileName}`,
          });
          if (!queued.ok) {
            setUpdateState({ state: 'error', source: 'lan', version: serverMeta.version, message: queued.error });
          } else {
            setUpdateState({
              state: 'downloaded',
              source: 'lan',
              version: serverMeta.version,
              progress: 100,
              message: 'Обновление скачано из локальной сети. Запускаем установку…',
            });
            await releaseUpdateLock();
            lockReleased = true;
            backgroundInFlight = false;
            showUpdateWindow(null);
            await installNow({ installerPath: cachedPath, version: serverMeta.version });
            return;
          }
        }
      }

      // 3) Yandex
      const y = await tryYandexDownload();
      if (y?.ok) {
        await releaseUpdateLock();
        lockReleased = true;
        backgroundInFlight = false;
        showUpdateWindow(null);
        await installNow({ installerPath: y.installerPath, version: y.version });
        return;
      }
      if (y && !y.ok) {
        candidateVersion = candidateVersion ?? y.version;
        candidateReason = candidateReason ?? y.error;
      }

      // 4) GitHub
      const gh = await tryGithubDownload();
      if (gh?.ok) {
        await releaseUpdateLock();
        lockReleased = true;
        backgroundInFlight = false;
        showUpdateWindow(null);
        await installNow({ installerPath: gh.installerPath, version: gh.version });
        return;
      }
      if (gh && !gh.ok) {
        candidateVersion = candidateVersion ?? gh.version;
        candidateReason = candidateReason ?? gh.error;
      }

      // 5) Любые торрент-пиры + webseed с сервера (/updates/file/:name)
      if (torrentMeta && compareSemver(torrentMeta.version, current) > 0) {
        candidateVersion = candidateVersion ?? torrentMeta.version;
        candidateReason = candidateReason ?? 'torrent peers failed';
        const tAny = await tryDownloadFromTorrentPeers(torrentMeta, { localOnly: false, includeServerWebSeed: true });
        if (tAny.ok) {
          const cachedPath = await cacheInstaller(tAny.filePath, torrentMeta.version);
          const queued = await queuePendingUpdate({
            version: torrentMeta.version,
            installerPath: cachedPath,
            expectedName: torrentMeta.fileName,
            expectedSize: torrentMeta.size,
            downloadUrl: tAny.downloadUrl,
          });
          if (queued.ok) {
            await releaseUpdateLock();
            lockReleased = true;
            backgroundInFlight = false;
            showUpdateWindow(null);
            await installNow({ installerPath: cachedPath, version: torrentMeta.version });
            return;
          }
        }
      }

      // 6) Ручной fallback через ссылку Яндекс.Диска + выбор пользователя.
      if (candidateVersion && Date.now() - lastManualUpdatePromptAt >= MANUAL_UPDATE_PROMPT_COOLDOWN_MS) {
        lastManualUpdatePromptAt = Date.now();
        const yCfg = await getYandexConfig().catch(() => null);
        showUpdateWindow(null);
        const choice = await promptManualUpdateFallback({
          version: candidateVersion,
          ...(yCfg?.publicKey ? { yandexUrl: yCfg.publicKey } : {}),
          ...(candidateReason ? { reason: candidateReason } : {}),
        });
        if (choice === 'close') {
          quitMainAppSoon(200);
          return;
        }
      }

      setUpdateState({ state: 'idle' });
    } catch (e) {
      setUpdateState({ state: 'error', source: 'yandex', message: String(e) });
    } finally {
      if (!lockReleased) {
        backgroundInFlight = false;
        if (lockAcquired) await releaseUpdateLock();
      }
    }
  }
}

export async function runAutoUpdateFlow(
  opts: { reason: 'startup' | 'manual_menu'; parentWindow?: BrowserWindow | null } = { reason: 'startup' },
): Promise<UpdateFlowResult> {
  if (updateInFlight) return { action: 'error', error: 'update already in progress' };
  updateInFlight = true;
  let lockAcquired = false;
  try {
    showUpdateWindow(opts.parentWindow ?? null);
    await stageUpdate('Проверяем обновления…', 0);

    if (!app.isPackaged) {
      closeUpdateWindowSoon(300);
      return { action: 'no_update' };
    }

    lockAcquired = await acquireUpdateLock('foreground');
    if (!lockAcquired) {
      await setUpdateUi('Обновление уже выполняется на этом ПК.', 100);
      closeUpdateWindowSoon(2500);
      return { action: 'error', error: 'update lock exists' };
    }

    await stageUpdate('Проверяем локальные обновления…', 2);
    const current = app.getVersion();
    const serverMeta = await fetchLatestUpdateMetaFromServer();
    const torrentLatest = await fetchLatestTorrentFromServer();
    const serverVersion = await getServerVersion();

    let candidateVersion: string | undefined;
    let candidateReason: string | undefined;

    const torrentMeta =
      torrentLatest.ok &&
      torrentLatest.updateAvailable &&
      torrentLatest.version &&
      torrentLatest.fileName &&
      torrentLatest.infoHash &&
      Number.isFinite(Number(torrentLatest.size ?? 0)) &&
      Number(torrentLatest.size ?? 0) > 0
        ? {
            version: torrentLatest.version,
            fileName: torrentLatest.fileName,
            size: Number(torrentLatest.size),
            infoHash: torrentLatest.infoHash,
            ...(serverMeta && serverMeta.version === torrentLatest.version && serverMeta.fileName === torrentLatest.fileName && serverMeta.sha256
              ? { sha256: serverMeta.sha256 }
              : {}),
          }
        : null;

    if (serverMeta && compareSemver(serverMeta.version, current) <= 0) {
      void tryAdvertiseLan(serverMeta).catch(() => {});
    }

    const local = await resolveLocalInstaller(current, serverVersion);
    if (local.action === 'install') {
      await installNow({ installerPath: local.installerPath, version: local.version });
      return { action: 'update_started' };
    }

    // 1) Сначала торрент-пиры локальные.
    if (torrentMeta && compareSemver(torrentMeta.version, current) > 0) {
      candidateVersion = torrentMeta.version;
      candidateReason = 'torrent local peers failed';
      await stageUpdate('Проверяем торрент-пиры в локальной сети…', 15, torrentMeta.version);
      const tLocal = await tryDownloadFromTorrentPeers(torrentMeta, {
        localOnly: true,
        onProgress: (pct, transferred, total) => {
          const safePct = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
          const transferredMb = Math.max(0, transferred) / (1024 * 1024);
          const totalMb = total && total > 0 ? total / (1024 * 1024) : null;
          const detail = totalMb
            ? `${transferredMb.toFixed(1)} / ${totalMb.toFixed(1)} MB`
            : `${transferredMb.toFixed(1)} MB`;
          void setUpdateUi(`Скачиваем (торрент-пиры, локальные)… ${detail}`, Math.max(5, safePct), torrentMeta.version);
        },
      });
      if (tLocal.ok) {
        const cachedPath = await cacheInstaller(tLocal.filePath, torrentMeta.version);
        const queued = await queuePendingUpdate({
          version: torrentMeta.version,
          installerPath: cachedPath,
          expectedName: torrentMeta.fileName,
          expectedSize: torrentMeta.size,
          downloadUrl: tLocal.downloadUrl,
        });
        if (!queued.ok) {
          await setUpdateUi(`Ошибка целостности: ${queued.error}`, 100, torrentMeta.version);
          candidateReason = queued.error;
        } else {
          await installNow({ installerPath: cachedPath, version: torrentMeta.version });
          return { action: 'update_started' };
        }
      }
    }

    // 2) Локальная LAN-раздача.
    if (serverMeta && compareSemver(serverMeta.version, current) > 0) {
      candidateVersion = candidateVersion ?? serverMeta.version;
      candidateReason = candidateReason ?? 'lan peers failed';
      await stageUpdate('Проверяем обновления в локальной сети…', 20);
      await stageUpdate('Скачиваем (локальная сеть)…', 5, serverMeta.version);
      setUpdateState({
        state: 'downloading',
        source: 'lan',
        version: serverMeta.version,
        progress: 0,
        message: 'Скачиваем обновление (Локальная сеть)…',
      });
      let lastLanUiAt = 0;
      const lan = await tryDownloadFromLan(serverMeta, {
        onProgress: (pct, transferred, total) => {
          const now = Date.now();
          if (now - lastLanUiAt < 250 && pct < 100) return;
          lastLanUiAt = now;
          const safePct = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
          const transferredMb = Math.max(0, transferred) / (1024 * 1024);
          const totalMb = total && total > 0 ? total / (1024 * 1024) : null;
          const detail = totalMb
            ? `${transferredMb.toFixed(1)} / ${totalMb.toFixed(1)} MB`
            : `${transferredMb.toFixed(1)} MB`;
          void setUpdateUi(`Скачиваем (Локальная сеть)… ${detail}`, Math.max(5, safePct), serverMeta.version);
          setUpdateState({
            state: 'downloading',
            source: 'lan',
            version: serverMeta.version,
            progress: safePct,
            message: 'Скачиваем обновление (Локальная сеть)…',
          });
        },
      });
      if (lan.ok) {
        const cachedPath = await cacheInstaller(lan.filePath, serverMeta.version);
        const queued = await queuePendingUpdate({
          version: serverMeta.version,
          installerPath: cachedPath,
          expectedName: serverMeta.fileName,
          expectedSize: serverMeta.size,
          downloadUrl: `lan://${serverMeta.fileName}`,
        });
        if (!queued.ok) {
          await setUpdateUi(`Ошибка целостности: ${queued.error}`, 100, serverMeta.version);
          setUpdateState({
            state: 'error',
            source: 'lan',
            version: serverMeta.version,
            message: queued.error,
          });
          candidateReason = queued.error;
        } else {
          setUpdateState({
            state: 'downloaded',
            source: 'lan',
            version: serverMeta.version,
            progress: 100,
            message: 'Обновление скачано из локальной сети. Запускаем установку…',
          });
          await installNow({ installerPath: cachedPath, version: serverMeta.version });
          return { action: 'update_started' };
        }
      }
    }

    // 3) Яндекс.Диск.
    await stageUpdate('Проверяем Яндекс.Диск…', 20);
    const y = await checkYandexForUpdates();
    if (y.ok && y.updateAvailable && y.version) {
      candidateVersion = candidateVersion ?? y.version;
      await stageUpdate(`Найдена новая версия (Yandex). Скачиваем…`, 5, y.version);
      await cleanupUpdateCache(y.version ?? 'latest');
      const yPath = 'path' in y ? y.path : undefined;
      const ydl = await downloadYandexUpdate(
        {
          version: y.version,
          ...(yPath ? { path: yPath } : {}),
          ...(y.downloadUrl ? { downloadUrl: y.downloadUrl } : {}),
        },
        {
        onProgress: (pct) => {
          void setUpdateUi(`Скачиваем (Yandex)…`, pct, y.version);
        },
        },
      );
      if (!ydl.ok || !ydl.filePath) {
        candidateReason = ydl.error ?? 'download failed';
      } else {
        const cachedPath = await cacheInstaller(ydl.filePath, y.version);
        const queued = await queuePendingUpdate({
          version: y.version ?? 'latest',
          installerPath: cachedPath,
          ...('path' in y && y.path ? { expectedName: y.path } : {}),
          expectedSize: y.expectedSize ?? null,
          downloadUrl: y.downloadUrl ?? null,
        });
        if (!queued.ok) {
          await setUpdateUi(`Ошибка целостности: ${queued.error}`, 100, y.version);
          candidateReason = queued.error;
        } else {
          await installNow({ installerPath: cachedPath, version: y.version });
          return { action: 'update_started' };
        }
      }
    }

    // 4) GitHub Releases.
    await stageUpdate('Проверяем обновления через GitHub…', 30);
    const gh = await checkGithubReleaseForUpdates();
    if (gh.ok && gh.updateAvailable && gh.downloadUrl && gh.version) {
      candidateVersion = candidateVersion ?? gh.version;
      await stageUpdate(`Найдена новая версия (GitHub). Скачиваем…`, 5, gh.version);
      await cleanupUpdateCache(gh.version ?? 'latest');
      const gdl = await downloadGithubUpdate(gh.downloadUrl, gh.version, {
        onProgress: (pct) => {
          void setUpdateUi(`Скачиваем (GitHub)…`, pct, gh.version);
        },
      });
      if (!gdl.ok || !gdl.filePath) {
        candidateReason = gdl.error ?? 'download failed';
      } else {
        const cachedPath = await cacheInstaller(gdl.filePath, gh.version);
        const queued = await queuePendingUpdate({
          version: gh.version ?? 'latest',
          installerPath: cachedPath,
          expectedSize: gh.expectedSize ?? null,
          downloadUrl: gh.downloadUrl ?? null,
        });
        if (!queued.ok) {
          await setUpdateUi(`Ошибка целостности: ${queued.error}`, 100, gh.version);
          candidateReason = queued.error;
        } else {
          await installNow({ installerPath: cachedPath, version: gh.version });
          return { action: 'update_started' };
        }
      }
    }

    // 5) Любые торрент-пиры + раздача с сервера (/updates/file/:name).
    if (torrentMeta && compareSemver(torrentMeta.version, current) > 0) {
      candidateVersion = candidateVersion ?? torrentMeta.version;
      candidateReason = candidateReason ?? 'torrent peers failed';
      await stageUpdate('Пробуем скачать через любые торрент-пиры и сервер…', 40, torrentMeta.version);
      const tAny = await tryDownloadFromTorrentPeers(torrentMeta, {
        localOnly: false,
        includeServerWebSeed: true,
        onProgress: (pct) => {
          void setUpdateUi('Скачиваем (торрент-пиры/сервер)…', pct, torrentMeta.version);
        },
      });
      if (tAny.ok) {
        const cachedPath = await cacheInstaller(tAny.filePath, torrentMeta.version);
        const queued = await queuePendingUpdate({
          version: torrentMeta.version,
          installerPath: cachedPath,
          expectedName: torrentMeta.fileName,
          expectedSize: torrentMeta.size,
          downloadUrl: tAny.downloadUrl,
        });
        if (queued.ok) {
          await installNow({ installerPath: cachedPath, version: torrentMeta.version });
          return { action: 'update_started' };
        }
        candidateReason = queued.error;
      }
    }

    // 6) Ручной fallback: ссылка на Яндекс.Диск + выбор пользователя.
    if (candidateVersion) {
      const yCfg = await getYandexConfig().catch(() => null);
      const choice = await promptManualUpdateFallback({
        version: candidateVersion,
        ...(yCfg?.publicKey ? { yandexUrl: yCfg.publicKey } : {}),
        ...(candidateReason ? { reason: candidateReason } : {}),
      });
      if (choice === 'close') {
        quitMainAppSoon(200);
        return { action: 'update_started' };
      }
      await stageUpdate('Продолжаем запуск приложения без автообновления.', 100);
      closeUpdateWindowSoon(500);
      return { action: 'no_update' };
    }

    await stageUpdate('Обновлений нет. Запускаем приложение…', 100);
    closeUpdateWindowSoon(700);
    return { action: 'no_update' };
  } catch (e) {
    const message = String(e);
    await setUpdateUi(`Ошибка обновления: ${message}`, 100);
    closeUpdateWindowSoon(3500);
    return { action: 'error', error: message };
  } finally {
    updateInFlight = false;
    if (lockAcquired) await releaseUpdateLock();
  }
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  try {
    if (!app.isPackaged) return { ok: true, updateAvailable: false };
    const torrent = await fetchLatestTorrentFromServer();
    if (torrent.ok && torrent.updateAvailable && torrent.version) {
      return {
        ok: true,
        updateAvailable: true,
        version: torrent.version,
        source: 'torrent',
        expectedSize: torrent.size != null ? Number(torrent.size) : null,
      };
    }
    const serverMeta = await fetchLatestUpdateMetaFromServer();
    if (serverMeta) {
      const current = app.getVersion();
      const updateAvailable = compareSemver(serverMeta.version, current) > 0;
      if (!updateAvailable) void tryAdvertiseLan(serverMeta).catch(() => {});
      return { ok: true, updateAvailable, version: serverMeta.version, source: 'lan' };
    }
    const y = await checkYandexForUpdates();
    if (y.ok && y.updateAvailable) return y;
    const gh = await checkGithubReleaseForUpdates();
    if (gh.ok && gh.updateAvailable) return gh;
    return { ok: true, updateAvailable: false };
  } catch (e) {
    const y = await checkYandexForUpdates().catch(() => null);
    if (y) return y;
    const gh = await checkGithubReleaseForUpdates().catch(() => null);
    if (gh) return gh;
    return { ok: false, error: String(e) };
  }
}

export async function runUpdateHelperFlow(args: UpdateHelperArgs): Promise<void> {
  try {
    showUpdateWindow(null);
    lockUpdateUi(true);
    await writeUpdaterLog(`update-helper flow start version=${args.version ?? 'unknown'} installer=${args.installerPath}`);
    await describePath('helper-installer', args.installerPath);
    await describePath('helper-launch', args.launchPath);
    await writeUpdaterLog(`update-helper appPath=${app.getAppPath()}`);
    await writeUpdaterLog(`update-helper resourcesPath=${process.resourcesPath}`);
    let parentTimedOut = false;
    if (args.parentPid) {
      await writeUpdaterLog(`update-helper waiting for parent pid=${args.parentPid}`);
      await setUpdateUi('Ожидаем закрытия программы…', 72, args.version);
      const startedAt = Date.now();
      let lastLogAt = 0;
      const maxWaitMs = 30_000;
      while (isProcessAlive(args.parentPid)) {
        const now = Date.now();
        if (now - startedAt >= maxWaitMs) {
          parentTimedOut = true;
          await writeUpdaterLog(
            `update-helper parent wait timeout ${Math.round((now - startedAt) / 1000)}s, continue install`,
          );
          break;
        }
        if (now - lastLogAt > 5000) {
          await writeUpdaterLog(`update-helper waiting: parent still running (${Math.round((now - startedAt) / 1000)}s)`);
          lastLogAt = now;
        }
        await sleep(1000);
      }
      if (!parentTimedOut) {
        await writeUpdaterLog(`update-helper parent exited after ${Math.round((Date.now() - startedAt) / 1000)}s`);
      }
    }
    if (parentTimedOut) {
      await setUpdateUi('Не удалось дождаться закрытия программы. Запускаем установку…', 80, args.version);
    } else {
      await setUpdateUi('Подготовка установки…', 70, args.version);
    }
    await setUpdateUi('Запускаем установку…', 80, args.version);
    await writeUpdaterLog(`update-helper launching installer (detached)`);
    const launchAttempts = [
      { delayMs: 1400, label: 'helper-try-1' },
      { delayMs: 3500, label: 'helper-try-2' },
      { delayMs: 7000, label: 'helper-try-3' },
    ];
    let ok = false;
    for (const attempt of launchAttempts) {
      await writeUpdaterLog(`update-helper launch attempt=${attempt.label}`);
      ok = await spawnInstallerDetached(args.installerPath, attempt.delayMs);
      if (ok) break;
      await writeUpdaterLog(`update-helper launch failed (${attempt.label})`);
    }
    if (!ok) {
      await writeUpdaterLog('installer launch failed, returning to app');
      await openInstallerFolder(args.installerPath);
      await setUpdateUi('Не удалось запустить установщик (возможно файл занят). Возвращаемся в приложение…', 100, args.version);
      closeUpdateWindowSoon(4000);
      spawn(args.launchPath, [], { detached: true, stdio: 'ignore', windowsHide: true });
      setTimeout(() => app.quit(), 4200);
      return;
    }
    await sleep(300);
    app.quit();
  } catch (e) {
    await writeUpdaterLog(`update-helper error: ${String(e)}`);
    await setUpdateUi(`Ошибка установки: ${String(e)}`, 100, args.version);
    closeUpdateWindowSoon(4000);
    spawn(args.launchPath, [], { detached: true, stdio: 'ignore', windowsHide: true });
    setTimeout(() => app.quit(), 4200);
  }
}


type YandexUpdateInfo =
  | {
      ok: true;
      updateAvailable: boolean;
      version?: string;
      path?: string;
      source: 'yandex';
      expectedSize?: number | null;
      downloadUrl?: string;
    }
  | { ok: false; error: string };
type YandexConfig = { publicKey: string; basePath: string };
type GithubReleaseInfo =
  | {
      ok: true;
      updateAvailable: boolean;
      version?: string;
      downloadUrl?: string;
      source: 'github';
      expectedSize?: number | null;
    }
  | { ok: false; error: string };

type TorrentLatestInfo =
  | {
      ok: true;
      updateAvailable: boolean;
      version?: string;
      fileName?: string;
      size?: number;
      infoHash?: string;
      torrentUrl?: string;
      source: 'torrent';
    }
  | { ok: false; error: string };

async function readReleaseInfo(): Promise<{ yandexPublicKey?: string; yandexBasePath?: string } | null> {
  try {
    const primary = join(app.getAppPath(), 'release-info.json');
    const raw = await readFile(primary, 'utf8').catch(() => null);
    if (raw) {
      const json = JSON.parse(raw) as any;
      return json?.update ?? null;
    }
    const fallback = join(process.resourcesPath, 'release-info.json');
    const raw2 = await readFile(fallback, 'utf8').catch(() => null);
    if (!raw2) return null;
    const json = JSON.parse(raw2) as any;
    return json?.update ?? null;
  } catch {
    return null;
  }
}

async function readPackageJson(): Promise<{ repository?: { url?: string } | string } | null> {
  try {
    const primary = join(app.getAppPath(), 'package.json');
    const raw = await readFile(primary, 'utf8').catch(() => null);
    if (!raw) return null;
    return JSON.parse(raw) as any;
  } catch {
    return null;
  }
}

function normalizePublicPath(p: string) {
  const out = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return out.startsWith('/') ? out : `/${out}`;
}

function joinPosix(a: string, b: string) {
  const aa = a.replaceAll('\\', '/').replace(/\/+$/, '');
  const bb = b.replaceAll('\\', '/').replace(/^\/+/, '');
  return `${aa}/${bb}`;
}

async function getYandexConfig(): Promise<YandexConfig | null> {
  const fromEnvKey = process.env.MATRICA_UPDATE_YANDEX_PUBLIC_KEY?.trim();
  const fromEnvPath = process.env.MATRICA_UPDATE_YANDEX_BASE_PATH?.trim();
  if (fromEnvKey) {
    return { publicKey: fromEnvKey, basePath: fromEnvPath ? normalizePublicPath(fromEnvPath) : 'latest' };
  }
  const info = await readReleaseInfo();
  const publicKey = String(info?.yandexPublicKey ?? '').trim();
  const basePath = String(info?.yandexBasePath ?? '').trim();
  if (!publicKey) return null;
  return { publicKey, basePath: basePath ? normalizePublicPath(basePath) : 'latest' };
}

function parseGithubRepoFromUrl(raw: string): { owner: string; repo: string } | null {
  const cleaned = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  const m = cleaned.match(/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function getGithubConfig(): Promise<{ owner: string; repo: string } | null> {
  const fromEnv = process.env.MATRICA_UPDATE_GITHUB_REPO?.trim();
  if (fromEnv) {
    const parts = fromEnv.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  }
  const pkg = await readPackageJson();
  const repo = (pkg as any)?.repository;
  const url = typeof repo === 'string' ? repo : repo?.url;
  if (url) {
    const parsed = parseGithubRepoFromUrl(String(url));
    if (parsed) return parsed;
  }
  return { owner: 'Valstan', repo: 'MatricaRMZ' };
}

async function getYandexDownloadHref(publicKey: string, path: string): Promise<string | null> {
  const url =
    'https://cloud-api.yandex.net/v1/disk/public/resources/download?' +
    new URLSearchParams({ public_key: publicKey, path: normalizePublicPath(path) }).toString();
  const res = await fetchWithRetry(
    url,
    { method: 'GET' },
    { attempts: 3, timeoutMs: UPDATE_CHECK_TIMEOUT_MS, backoffMs: 500, maxBackoffMs: 3000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
  );
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as any;
  return typeof json?.href === 'string' ? json.href : null;
}

async function listPublicFolder(publicKey: string, pathOnDisk: string): Promise<Array<{ name: string; size?: number | null }>> {
  const api =
    'https://cloud-api.yandex.net/v1/disk/public/resources?' +
    new URLSearchParams({
      public_key: publicKey,
      path: normalizePublicPath(pathOnDisk),
      limit: '200',
    }).toString();
  const r = await fetchWithRetry(
    api,
    { method: 'GET' },
    { attempts: 3, timeoutMs: UPDATE_CHECK_TIMEOUT_MS, backoffMs: 500, maxBackoffMs: 3000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
  );
  if (!r.ok) throw new Error(`Yandex list failed ${r.status}`);
  const json = (await r.json().catch(() => null)) as any;
  const items = (json?._embedded?.items ?? []) as any[];
  return items
    .map((x) => ({
      name: String(x?.name ?? ''),
      size: x?.size != null ? Number(x.size) : null,
    }))
    .filter((x) => x.name);
}

function extractVersionFromFileName(fileName: string): string | null {
  const m = fileName.match(/(\d+\.\d+\.\d+)/);
  return m?.[1] ?? null;
}

function resolveUpdateVersion(version?: string, fileName?: string) {
  const cleaned = version?.trim();
  if (cleaned) return cleaned;
  const fromName = fileName ? extractVersionFromFileName(fileName) : null;
  return fromName ?? 'latest';
}

function getUpdateDownloadDir(version?: string, fileName?: string) {
  const ver = resolveUpdateVersion(version, fileName);
  return join(getUpdatesRootDir(), ver);
}

async function tryAdvertiseLan(meta: ServerUpdateMeta): Promise<void> {
  const apiBaseUrl = await resolveUpdateApiBaseUrl();
  if (!apiBaseUrl) return;
  await logLan(`advertise start version=${meta.version} file=${meta.fileName}`);
  const cached = await findCachedInstallerForVersion(meta.version, meta.fileName);
  if (!cached) {
    await logLan('advertise skip: cached installer not found');
    return;
  }
  const integrity = await validateInstallerIntegrity(cached.filePath, meta.fileName, meta.size, meta.sha256);
  if (!integrity.ok) {
    await logLan(`advertise skip: integrity ${integrity.error}`);
    return;
  }
  const server = await startLanUpdateServer(cached.filePath, meta.fileName);
  if (!server.ok) {
    await logLan(`advertise server failed: ${server.error}`);
    return;
  }
  const peers = getLocalLanPeers(server.port);
  if (peers.length === 0) {
    await logLan('advertise skip: no LAN peers found');
    return;
  }
  const registered = await registerLanPeers(apiBaseUrl, meta.version, peers);
  if (!registered.ok) {
    await logLan(`advertise registry failed: ${registered.error}`);
    return;
  }
  const latestTorrent = await fetchLatestTorrentFromServer();
  if (latestTorrent.ok && latestTorrent.infoHash && latestTorrent.version === meta.version) {
    const tReg = await registerUpdatePeers(apiBaseUrl, latestTorrent.infoHash, peers);
    if (!tReg.ok) await logTorrent(`advertise peer registry failed: ${tReg.error}`);
  }
  await logLan(`advertise ok: port=${server.port} peers=${peers.length}`);
}

async function tryDownloadFromLan(
  meta: ServerUpdateMeta,
  opts?: { onProgress?: (pct: number, transferred: number, total: number | null) => void },
): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> {
  const apiBaseUrl = await resolveUpdateApiBaseUrl();
  if (!apiBaseUrl) return { ok: false as const, error: 'apiBaseUrl missing' };
  const serverPort = getLanServerPort() ?? undefined;
  const selfPeers = getLocalLanPeers(serverPort ?? 0);
  const excludeIp = selfPeers[0]?.ip;
  const peers = await listLanPeers(apiBaseUrl, meta.version, excludeIp ? { ip: excludeIp, ...(serverPort != null ? { port: serverPort } : {}) } : undefined);
  await logLan(`download peers=${peers.length} version=${meta.version}`);
  if (!peers.length) return { ok: false as const, error: 'no peers' };

  const outDir = getUpdateDownloadDir(meta.version, meta.fileName);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, meta.fileName);

  for (const peer of peers) {
    const ip = String(peer.ip ?? '').trim();
    const port = Number(peer.port ?? 0);
    if (!ip || !Number.isFinite(port) || port <= 0) continue;
    const url = `http://${ip}:${port}/updates/file/${encodeURIComponent(meta.fileName)}`;
    await logLan(`download try peer=${ip}:${port}`);
    const dl = await downloadWithResume(url, outPath, {
      attempts: 3,
      timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
      noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
      useBitsOnWindows: false,
      backoffMs: 800,
      maxBackoffMs: 6000,
      jitterMs: 300,
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    if (!dl.ok || !dl.filePath) {
      await logLan(`download failed peer=${ip}:${port} error=${dl.error ?? 'unknown'}`);
      continue;
    }
    const integrity = await validateInstallerIntegrity(outPath, meta.fileName, meta.size, meta.sha256);
    if (!integrity.ok) {
      await logLan(`download integrity failed peer=${ip}:${port} error=${integrity.error}`);
      await rm(outPath, { force: true }).catch(() => {});
      continue;
    }
    await logLan(`download ok peer=${ip}:${port}`);
    return { ok: true as const, filePath: outPath };
  }
  return { ok: false as const, error: 'lan download failed' };
}

function pickNewestInstaller(items: Array<{ name: string; size?: number | null }>): { name: string; size?: number | null } | null {
  const exes = items.filter((n) => n.name.toLowerCase().endsWith('.exe'));
  if (exes.length === 0) return null;
  const preferred = exes.filter((n) => isSetupInstallerName(n.name));
  const candidates = preferred.length > 0 ? preferred : exes;
  const parsed = candidates
    .map((n) => ({ n, v: extractVersionFromFileName(n.name) }))
    .filter((x) => x.v);
  if (parsed.length === 0) return candidates[0] ?? null;
  parsed.sort((a, b) => compareSemver(b.v!, a.v!));
  return parsed[0]?.n ?? null;
}

async function getYandexItemMeta(publicKey: string, pathOnDisk: string): Promise<{ size?: number | null } | null> {
  const api =
    'https://cloud-api.yandex.net/v1/disk/public/resources?' +
    new URLSearchParams({
      public_key: publicKey,
      path: normalizePublicPath(pathOnDisk),
    }).toString();
  const r = await fetchWithRetry(
    api,
    { method: 'GET' },
    { attempts: 3, timeoutMs: UPDATE_CHECK_TIMEOUT_MS, backoffMs: 500, maxBackoffMs: 3000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
  );
  if (!r.ok) return null;
  const json = (await r.json().catch(() => null)) as any;
  return { size: json?.size != null ? Number(json.size) : null };
}

// download helper moved to netFetch.ts

function parseLatestYml(text: string): { version?: string; path?: string } {
  const ver = text.match(/^version:\s*["']?([^\n"']+)["']?/m)?.[1];
  const path = text.match(/^path:\s*["']?([^\n"']+)["']?/m)?.[1];
  return { ...(ver?.trim() ? { version: ver.trim() } : {}), ...(path?.trim() ? { path: path.trim() } : {}) };
}

async function checkYandexForUpdates(): Promise<UpdateCheckResult | YandexUpdateInfo> {
  const cfg = await getYandexConfig();
  if (!cfg) return { ok: false, error: 'yandex update is not configured' };
  const { publicKey, basePath } = cfg;
  try {
    const latestPath = joinPosix(basePath, 'latest.yml');
    const href = await getYandexDownloadHref(publicKey, latestPath);
    if (href) {
      const res = await fetchWithRetry(
        href,
        { method: 'GET' },
        { attempts: 3, timeoutMs: UPDATE_CHECK_TIMEOUT_MS, backoffMs: 500, maxBackoffMs: 3000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
      );
      if (res.ok) {
        const text = await res.text();
        const parsed = parseLatestYml(text);
        const latest = parsed.version ?? '';
        if (latest) {
          const current = app.getVersion();
          const updateAvailable = compareSemver(latest, current) > 0;
          const meta = parsed.path ? await getYandexItemMeta(publicKey, joinPosix(basePath, parsed.path)) : null;
          const href = parsed.path ? await getYandexDownloadHref(publicKey, joinPosix(basePath, parsed.path)) : null;
          return {
            ok: true,
            updateAvailable,
            version: latest,
            ...(parsed.path ? { path: parsed.path } : {}),
            source: 'yandex',
            expectedSize: meta?.size ?? null,
            ...(href ? { downloadUrl: href } : {}),
          };
        }
      }
    }

    const items = await listPublicFolder(publicKey, basePath);
    const exe = pickNewestInstaller(items);
    if (!exe) return { ok: false, error: 'no installer found in yandex folder' };
    await writeUpdaterLog(`yandex pick installer=${exe.name}`);
    const version = extractVersionFromFileName(exe.name);
    if (!version) return { ok: false, error: 'cannot extract version from installer name' };
    const current = app.getVersion();
    const updateAvailable = compareSemver(version, current) > 0;
    const exeHref = await getYandexDownloadHref(publicKey, joinPosix(basePath, exe.name));
    return {
      ok: true,
      updateAvailable,
      version,
      path: exe.name,
      source: 'yandex',
      expectedSize: exe.size ?? null,
      ...(exeHref ? { downloadUrl: exeHref } : {}),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function checkGithubReleaseForUpdates(): Promise<UpdateCheckResult | GithubReleaseInfo> {
  const cfg = await getGithubConfig();
  if (!cfg) return { ok: false, error: 'github update is not configured' };
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/latest`;
  try {
    const res = await fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'MatricaRMZ-Updater',
        },
      },
      { attempts: 3, timeoutMs: 20_000, backoffMs: 600, maxBackoffMs: 4000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
    );
    if (!res.ok) return { ok: false, error: `github release HTTP ${res.status}` };
    const json = (await res.json().catch(() => null)) as any;
    if (!json || json.draft) return { ok: true, updateAvailable: false };
    const tag = String(json?.tag_name ?? '').trim();
    const version = tag.replace(/^v/i, '');
    if (!version) return { ok: false, error: 'github release has no version' };
    const current = app.getVersion();
    const updateAvailable = compareSemver(version, current) > 0;
    if (!updateAvailable) return { ok: true, updateAvailable: false };
    const assets = Array.isArray(json?.assets) ? json.assets : [];
    const exeCandidates = assets
      .filter((a: any) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('.exe'))
      .map((a: any) => a as { name: string; browser_download_url?: string; size?: number });
    const preferred = exeCandidates.find((a: { name: string }) => isSetupInstallerName(a.name));
    const exe = preferred ?? exeCandidates[0];
    const downloadUrl = exe?.browser_download_url ? String(exe.browser_download_url) : undefined;
    if (!downloadUrl) return { ok: false, error: 'github release missing exe asset' };
    await writeUpdaterLog(`github pick installer=${exe?.name ?? 'unknown'}`);
    return {
      ok: true,
      updateAvailable: true,
      version,
      downloadUrl,
      source: 'github',
      expectedSize: exe?.size != null ? Number(exe.size) : null,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function downloadYandexUpdate(
  info: { version?: string; path?: string; downloadUrl?: string },
  opts?: { onProgress?: (pct: number, transferred: number, total: number | null) => void },
) {
  try {
    const cfg = await getYandexConfig();
    if (!cfg) return { ok: false as const, error: 'yandex update is not configured' };
    const { publicKey, basePath } = cfg;
    let fileName = info.path ?? '';
    if (!fileName) {
      const items = await listPublicFolder(publicKey, basePath);
      const exe = pickNewestInstaller(items);
      if (!exe) return { ok: false as const, error: 'no installer found in yandex folder' };
      fileName = exe.name;
    }
    const filePath = joinPosix(basePath, fileName);
    const href = info.downloadUrl ?? (await getYandexDownloadHref(publicKey, filePath));
    if (!href) return { ok: false as const, error: 'yandex installer not found' };
    const outDir = getUpdateDownloadDir(info.version, fileName);
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, fileName);
    return await downloadWithResume(href, outPath, {
      attempts: 4,
      timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
      noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
      useBitsOnWindows: true,
      bitsTimeoutMs: UPDATE_BITS_TIMEOUT_MS,
      backoffMs: 800,
      maxBackoffMs: 6000,
      jitterMs: 300,
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    });
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

async function downloadGithubUpdate(
  url: string,
  version?: string,
  opts?: { onProgress?: (pct: number, transferred: number, total: number | null) => void },
) {
  try {
    const fileName = basename(new URL(url).pathname) || `MatricaRMZ-${version ?? 'update'}.exe`;
    const outDir = getUpdateDownloadDir(version, fileName);
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, fileName);
    return await downloadWithResume(url, outPath, {
      attempts: 4,
      timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
      noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
      useBitsOnWindows: true,
      bitsTimeoutMs: UPDATE_BITS_TIMEOUT_MS,
      backoffMs: 800,
      maxBackoffMs: 6000,
      jitterMs: 300,
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    });
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

async function prepareUpdateHelper(): Promise<{ helperExePath: string; launchPath: string; resourcesPath: string }> {
  if (!app.isPackaged) throw new Error('Update helper requires packaged app');
  const launchPath = process.execPath;
  const appDir = dirname(launchPath);
  const helperExePath = launchPath;
  const appPath = app.getAppPath();
  const appPathDir = appPath ? dirname(appPath) : null;
  const candidates = Array.from(
    new Set([join(appDir, 'resources'), process.resourcesPath, appPathDir].filter(Boolean) as string[]),
  );
  for (const resourcesDir of candidates) {
    const asarPath = join(resourcesDir, 'app.asar');
    const asarStat = await stat(asarPath).catch(() => null);
    if (asarStat && asarStat.isFile()) {
      return { helperExePath, launchPath, resourcesPath: resourcesDir };
    }
    const appDirPath = join(resourcesDir, 'app');
    const appDirStat = await stat(appDirPath).catch(() => null);
    if (appDirStat && appDirStat.isDirectory()) {
      return { helperExePath, launchPath, resourcesPath: resourcesDir };
    }
  }

  if (appPath) {
    if (appPath.endsWith('.asar')) {
      return { helperExePath, launchPath, resourcesPath: dirname(appPath) };
    }
    if (basename(appPath).toLowerCase() === 'app') {
      return { helperExePath, launchPath, resourcesPath: dirname(appPath) };
    }
  }

  const fallback = process.resourcesPath || join(appDir, 'resources');
  return { helperExePath, launchPath, resourcesPath: fallback };
}

async function spawnUpdateHelper(args: {
  helperExePath: string;
  installerPath: string;
  launchPath: string;
  resourcesPath: string;
  version?: string;
  parentPid?: number;
}): Promise<boolean> {
  const spawnArgs = ['--update-helper', '--installer', args.installerPath, '--launch', args.launchPath];
  if (args.version) spawnArgs.push('--version', args.version);
  if (args.parentPid) spawnArgs.push('--parent-pid', String(args.parentPid));
  try {
    void writeUpdaterLog(`update-helper args: ${spawnArgs.map((a) => JSON.stringify(a)).join(' ')}`);
    const child = spawn(args.helperExePath, spawnArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_OVERRIDE_RESOURCES_PATH: args.resourcesPath,
      },
    });
    child.unref();
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      child.once('spawn', () => {
        void writeUpdaterLog('update-helper spawned');
        finish(true);
      });
      child.once('error', (err) => {
        void writeUpdaterLog(`update-helper spawn error: ${String(err)}`);
        finish(false);
      });
      setTimeout(() => finish(true), 200);
    });
  } catch (e) {
    void writeUpdaterLog(`update-helper spawn exception: ${String(e)}`);
    return false;
  }
}

function isProcessAlive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnInstallerDetached(installerPath: string, delayMs = 1200): Promise<boolean> {
  await describePath('installer-detached', installerPath);
  const attempts = [
    { delayMs: Math.max(200, delayMs), label: 'initial' },
    { delayMs: 2000, label: 'retry-1' },
    { delayMs: 5000, label: 'retry-2' },
    { delayMs: 10_000, label: 'retry-3' },
  ];

  const runWithOutput = async (label: string, cmd: string, args: string[]) => {
    try {
      await writeUpdaterLog(`installer launch strategy=${label} cmd=${cmd} args=${args.map((a) => JSON.stringify(a)).join(' ')}`);
      return await new Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (buf) => {
          stdout += String(buf);
        });
        child.stderr?.on('data', (buf) => {
          stderr += String(buf);
        });
        child.once('error', (err) => {
          resolve({ ok: false, code: null, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${String(err)}` });
        });
        child.once('close', (code) => {
          resolve({ ok: code === 0, code: code ?? null, stdout, stderr });
        });
      });
    } catch (e) {
      return { ok: false, code: null, stdout: '', stderr: String(e) };
    }
  };

  const tryCmdStart = async (label: string) => {
    const args = ['/c', 'start', '""', installerPath];
    const res = await runWithOutput(`cmd-start-${label}`, 'cmd.exe', args);
    if (!res.ok) {
      await writeUpdaterLog(
        `installer launch cmd-start failed (${label}) code=${res.code ?? 'n/a'} stdout=${res.stdout.trim()} stderr=${res.stderr.trim()}`,
      );
      return false;
    }
    await writeUpdaterLog(`installer launched via cmd-start (${label})`);
    return true;
  };

  const tryPowerShell = async () => {
    const escaped = installerPath.replace(/"/g, '`"');
    const cmd = `Start-Process -FilePath "${escaped}" -Verb RunAs -PassThru | Select-Object -ExpandProperty Id`;
    const res = await runWithOutput('powershell-start', 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd]);
    if (!res.ok) {
      await writeUpdaterLog(
        `installer launch powershell failed code=${res.code ?? 'n/a'} stdout=${res.stdout.trim()} stderr=${res.stderr.trim()}`,
      );
      return false;
    }
    const pid = Number(res.stdout.trim().split(/\s+/).at(-1));
    if (!Number.isFinite(pid) || pid <= 0) {
      await writeUpdaterLog(`installer launch powershell returned invalid pid stdout=${res.stdout.trim()}`);
      return false;
    }
    await writeUpdaterLog(`installer launched via powershell-start pid=${pid}`);
    return true;
  };

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    if (!attempt) continue;
    await writeUpdaterLog(`installer launch scheduled in ${Math.round(attempt.delayMs / 1000)}s (${attempt.label})`);
    await sleep(attempt.delayMs);
    try {
      if (process.platform === 'win32') {
        if (await tryCmdStart(attempt.label)) {
          return true;
        }
        if (await tryPowerShell()) {
          return true;
        }
      }
      await writeUpdaterLog(`installer launch strategy=shell-open path=${installerPath}`);
      const result = await shell.openPath(installerPath);
      if (!result) {
        await writeUpdaterLog(`installer launched via shell-open (${attempt.label})`);
        return true;
      }
      await writeUpdaterLog(`installer launch error (shell-open): ${result}`);
    } catch (e) {
      const msg = String(e);
      await writeUpdaterLog(`installer launch exception (shell-open): ${msg}`);
      if (!msg.toLowerCase().includes('ebusy')) return false;
    }
    await writeUpdaterLog(`installer launch attempt ${attempt.label} failed, retrying`);
  }

  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x));
  const pb = b.split('.').map((x) => Number(x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}


