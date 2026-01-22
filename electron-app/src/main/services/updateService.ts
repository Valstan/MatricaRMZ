import { app, BrowserWindow } from 'electron';
import updater from 'electron-updater';
import { spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, stat, writeFile, access, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  buildTorrentManifestUrl,
  downloadTorrentUpdate,
  fetchTorrentManifest,
  fetchTorrentStatus,
  saveTorrentFileForVersion,
  saveTorrentSeedInfo,
  stopTorrentDownload,
  stopTorrentSeeding,
  type TorrentClientStats,
  type TorrentUpdateManifest,
} from './torrentUpdateService.js';
import { getNetworkState } from './networkService.js';
import { downloadWithResume, fetchWithRetry } from './netFetch.js';

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string; source?: 'torrent' | 'github' | 'yandex'; downloadUrl?: string }
  | { ok: false; error: string };

export type UpdateFlowResult =
  | { action: 'no_update' }
  | { action: 'update_started' }
  | { action: 'update_downloaded'; version?: string; source?: 'torrent' | 'github' | 'yandex' }
  | { action: 'error'; error: string };

export type UpdateHelperArgs = {
  installerPath: string;
  launchPath: string;
  version?: string;
  parentPid?: number;
};

const autoUpdater = updater.autoUpdater;

const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 30_000;

function getUpdateApiBaseUrl() {
  const envUrl = process.env.MATRICA_UPDATE_API_URL?.trim() || process.env.MATRICA_API_URL?.trim();
  if (envUrl) {
    const cleaned = envUrl.replace(/\/+$/, '');
    if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) return cleaned;
    return `http://${cleaned}`;
  }
  return 'http://a6fd55b8e0ae.vps.myjino.ru';
}

const NETWORK_GRACE_MS = 120_000;

export function initAutoUpdate() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
}

let updateInFlight = false;
let backgroundInFlight = false;
let updateUiWindow: BrowserWindow | null = null;
let updateUiLocked = false;
const updateLog: string[] = [];

type UpdateRuntimeState = {
  state: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error';
  source?: 'torrent' | 'github' | 'yandex';
  version?: string;
  progress?: number;
  message?: string;
  updatedAt: number;
};

let updateState: UpdateRuntimeState = { state: 'idle', updatedAt: Date.now() };
let torrentDebugInfo: TorrentClientStats | null = null;
let torrentDebugUpdatedAt = 0;

function updaterLogPath() {
  return join(app.getPath('userData'), 'matricarmz-updater.log');
}

function getUpdatesRootDir() {
  return join(app.getPath('downloads'), 'MatricaRMZ-Updates');
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
    await appendFile(updaterLogPath(), `[${ts}] ${message}\n`, 'utf8');
  } catch {
    // ignore log write failures
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

function isSetupInstallerName(name: string) {
  return /(setup|installer)/i.test(name);
}

async function validateInstallerPath(
  installerPath: string,
  expectedName?: string,
): Promise<{ ok: true; isSetup: boolean; size: number } | { ok: false; error: string }> {
  const st = await stat(installerPath).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, error: 'installer file is missing' };
  if (st.size <= 0) return { ok: false, error: 'installer file is empty' };
  const actualName = basename(installerPath);
  const expected = expectedName ? basename(expectedName) : '';
  const expectedRequiresSetup = expected ? isSetupInstallerName(expected) : false;
  const actualIsSetup = isSetupInstallerName(actualName);
  if (expectedRequiresSetup && !actualIsSetup) {
    return { ok: false, error: `installer mismatch: expected setup, got ${actualName}` };
  }
  return { ok: true, isSetup: actualIsSetup, size: st.size };
}

async function queuePendingUpdate(args: {
  version: string;
  installerPath: string;
  expectedName?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const validation = await validateInstallerPath(args.installerPath, args.expectedName);
  if (!validation.ok) return validation;
  await writePendingUpdate({ version: args.version, installerPath: args.installerPath });
  await writeUpdaterLog(
    `pending-update saved version=${args.version} installer=${args.installerPath} size=${validation.size}`,
  );
  return { ok: true };
}

async function installNow(args: { installerPath: string; version?: string }) {
  await stageUpdate('Скачивание завершено. Готовим установку…', 60, args.version);
  lockUpdateUi(true);
  await stageUpdate('Подготовка установщика…', 70, args.version);
  const helper = await prepareUpdateHelper();
  await writeUpdaterLog(`update-helper spawn version=${args.version ?? 'unknown'} installer=${args.installerPath}`);
  const spawned = await spawnUpdateHelper({
    helperExePath: helper.helperExePath,
    installerPath: args.installerPath,
    launchPath: helper.launchPath,
    resourcesPath: helper.resourcesPath,
    version: args.version,
    parentPid: process.pid,
  });
  if (!spawned) {
    await writeUpdaterLog('update-helper spawn failed, keeping pending update');
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
  const safe = items.replace(/'/g, "\\'");
  const js = `document.getElementById('log').innerHTML='${safe}';`;
  await w.webContents.executeJavaScript(js, true).catch(() => {});
  const lineCount = Math.min(updateLog.length, 18);
  const baseHeight = 220;
  const lineHeight = 18;
  const targetHeight = Math.min(720, Math.max(320, baseHeight + lineCount * lineHeight));
  try {
    const [curW, curH] = w.getSize();
    if (targetHeight > curH) w.setSize(Math.max(curW, 640), targetHeight);
  } catch {
    // ignore resize errors
  }
}

async function addUpdateLog(line: string) {
  updateLog.push(line);
  while (updateLog.length > 18) updateLog.shift();
  await renderUpdateLog();
}

function formatBytesPerSec(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = value;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  return `${v.toFixed(v >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = value;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  return `${v.toFixed(v >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

async function renderTorrentDebug() {
  const w = updateUiWindow;
  if (!w || w.isDestroyed()) return;
  const info = torrentDebugInfo;
  if (!info) {
    const js = `document.getElementById('torrentDebug').innerText='';`;
    await w.webContents.executeJavaScript(js, true).catch(() => {});
    return;
  }
  const lines: string[] = [];
  lines.push(
    `Torrent: ${info.progressPct}% · peers=${info.numPeers} · seeds=${info.numSeeds ?? 0} · down=${formatBytesPerSec(info.downloadSpeed)} · up=${formatBytesPerSec(info.uploadSpeed)}`,
  );
  lines.push(
    `Total: downloaded=${formatBytes(info.downloaded ?? 0)} · uploaded=${formatBytes(info.uploaded ?? 0)} · ratio=${(info.ratio ?? 0).toFixed(2)} · ETA=${formatDuration(info.timeRemainingMs ?? 0)}`,
  );
  for (const peer of info.peers) {
    const addr = peer.port ? `${peer.address}:${peer.port}` : peer.address;
    const dl = formatBytesPerSec(peer.downloadSpeed ?? 0);
    const ul = formatBytesPerSec(peer.uploadSpeed ?? 0);
    const flags = [
      peer.local ? 'LAN' : 'WAN',
      peer.peerChoking ? 'choking' : 'open',
      peer.peerInterested ? 'interested' : 'idle',
    ]
      .filter(Boolean)
      .join(',');
    lines.push(`${addr} · down=${dl} · up=${ul} · ${flags}`);
  }
  const safe = lines.map((line) => line.replace(/'/g, "\\'")).join('\\n');
  const js = `document.getElementById('torrentDebug').innerText='${safe}';`;
  await w.webContents.executeJavaScript(js, true).catch(() => {});
}

async function setTorrentDebug(info: TorrentClientStats | null) {
  torrentDebugInfo = info;
  const now = Date.now();
  if (now - torrentDebugUpdatedAt < 900) return;
  torrentDebugUpdatedAt = now;
  await renderTorrentDebug();
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
  torrentDebugInfo = null;
  updateUiWindow = new BrowserWindow({
    width: 640,
    height: 360,
    minWidth: 520,
    minHeight: 320,
    modal: !!parent,
    parent: parent ?? undefined,
    title: `Обновление MatricaRMZ`,
    resizable: true,
    minimizable: false,
    maximizable: true,
    alwaysOnTop: true,
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
    .torrent{margin-top:10px;font-size:12px;color:#0f172a;background:#f8fafc;border:1px dashed #cbd5f5;padding:8px;border-radius:8px;white-space:pre-wrap}
    .log{margin-top:10px; font-size:12px; color:#4b5563}
    .log-item{margin-top:4px}
  </style></head>
  <body>
    <h2 style="margin:0">Обновление</h2>
    <div id="msg" class="muted" style="margin-top:8px">Проверяем обновления…</div>
    <div class="row"><div class="pct" id="pct">0%</div><div class="muted" id="ver"></div></div>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div id="torrentDebug" class="torrent"></div>
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
      app.quit();
    } catch {
      // ignore
    }
  }, ms);
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
      if (entry.name === 'torrent-seed.json') {
        const raw = await readFile(entryPath, 'utf8').catch(() => null);
        const json = raw ? (JSON.parse(raw) as any) : null;
        if (!json?.version || json.version !== keepVersion) {
          await rm(entryPath, { force: true }).catch(() => {});
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

async function writePendingUpdate(data: { version: string; installerPath: string }) {
  const outDir = getUpdatesRootDir();
  await mkdir(outDir, { recursive: true });
  await writeFile(pendingUpdatePath(), JSON.stringify(data, null, 2), 'utf8');
}

async function readPendingUpdate(): Promise<{ version: string; installerPath: string } | null> {
  try {
    const raw = await readFile(pendingUpdatePath(), 'utf8');
    const json = JSON.parse(raw) as any;
    if (!json?.version || !json?.installerPath) return null;
    return { version: String(json.version), installerPath: String(json.installerPath) };
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
    const installerPath = join(dir, preferred);
    const validation = await validateInstallerPath(installerPath, preferred);
    if (!validation.ok) continue;
    return { version: ver, installerPath };
  }
  return null;
}

async function resolveLocalInstaller(currentVersion: string, serverVersion: string | null) {
  const pending = await readPendingUpdate();
  if (pending?.version && compareSemver(pending.version, currentVersion) > 0) {
    const validation = await validateInstallerPath(pending.installerPath, pending.installerPath);
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
    const baseUrl = getUpdateApiBaseUrl();
    const manifest = await fetchTorrentManifest(baseUrl);
    if (manifest?.version) return manifest.version;
  } catch {
    // ignore
  }
  return null;
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
      const baseUrl = getUpdateApiBaseUrl();
      const manifest = await fetchTorrentManifest(baseUrl);
      if (manifest?.version && compareSemver(manifest.version, pending.version) > 0) {
        await writeUpdaterLog(
          `pending-update superseded by server: pending=${pending.version} latest=${manifest.version}`,
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
  showUpdateWindow(parentWindow ?? null);
  lockUpdateUi(true);
  await setUpdateUi('Найдена скачанная версия. Устанавливаем…', 80, pending.version);
  await writeUpdaterLog(`update-helper start version=${pending.version} installer=${pending.installerPath}`);
  await addUpdateLog(`update helper: stopping torrent download`);
  await stopTorrentDownload().catch(() => {});
  await writeUpdaterLog('pending-update will be cleared after helper spawn');
  await addUpdateLog(`update helper: resolving resources path`);
  const helper = await prepareUpdateHelper();
  await addUpdateLog(`update helper: resources=${helper.resourcesPath}`);
  await writeUpdaterLog(`update-helper resources=${helper.resourcesPath} launch=${helper.launchPath}`);
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

function formatTorrentStatusError(status: any) {
  const lastError = String(status?.lastError ?? '').trim();
  const updatesDir = status?.updatesDir ? String(status.updatesDir) : '';
  if (!lastError) return updatesDir ? `updates dir: ${updatesDir}` : '';
  if (lastError === 'updates_dir_not_set') return 'updates_dir_not_set: set MATRICA_UPDATES_DIR';
  if (lastError === 'no_installer_found') return 'no_installer_found: put latest .exe into updates dir';
  return updatesDir ? `${lastError} (dir=${updatesDir})` : lastError;
}

function isTransientMessage(msg: string) {
  const m = msg.toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('network') ||
    m.includes('offline') ||
    m.includes('enotfound') ||
    m.includes('econnreset') ||
    m.includes('eai_again') ||
    m.includes('stalled')
  );
}

function shouldHoldSource(error?: string) {
  const state = getNetworkState();
  if (!state.online) return true;
  if (Date.now() - state.lastChangeAt < NETWORK_GRACE_MS) return true;
  if (error && isTransientMessage(error)) return true;
  return false;
}

async function checkTorrentForUpdates(): Promise<
  | { ok: true; updateAvailable: boolean; version?: string; manifest?: TorrentUpdateManifest }
  | { ok: false; error: string }
> {
  try {
    if (!app.isPackaged) return { ok: true, updateAvailable: false };
    const baseUrl = getUpdateApiBaseUrl();
    const manifest = await fetchTorrentManifest(baseUrl);
    if (!manifest) {
      const status = await fetchTorrentStatus(baseUrl);
      if (status.ok) {
        const reason = formatTorrentStatusError(status.status);
        const msg = reason ? `torrent ${reason}` : 'torrent update not available';
        return { ok: false, error: msg };
      }
      return { ok: false, error: status.error || 'torrent update not available' };
    }
    const current = app.getVersion();
    const updateAvailable = compareSemver(manifest.version, current) > 0;
    return {
      ok: true,
      updateAvailable,
      version: manifest.version,
      manifest: { ...manifest, torrentUrl: buildTorrentManifestUrl(baseUrl, manifest.torrentUrl) },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function ensureTorrentSeedArtifacts(manifest: TorrentUpdateManifest | null, installerPath: string, version?: string) {
  if (!manifest || !manifest.torrentUrl || !version) return;
  const torrentPath = await saveTorrentFileForVersion(version, manifest.torrentUrl);
  if (!torrentPath) return;
  await saveTorrentSeedInfo({ version, installerPath, torrentPath });
}

async function backgroundTorrentDownload(manifest: TorrentUpdateManifest, version: string) {
  setUpdateState({ state: 'downloading', source: 'torrent', version, progress: 0, message: 'Скачиваем обновление…' });
  await stopTorrentSeeding().catch(() => {});
  await stopTorrentDownload().catch(() => {});
  await cleanupUpdateCache(version);
  const tdl = await downloadTorrentUpdate(manifest, {
    onProgress: (pct, peers) => {
      setUpdateState({
        state: 'downloading',
        source: 'torrent',
        version,
        progress: pct,
        message: `Скачиваем обновление… Пиры: ${peers}`,
      });
    },
  });
  if (!tdl.ok) {
    setUpdateState({ state: 'error', source: 'torrent', version, message: String(tdl.error ?? 'torrent download failed') });
    return;
  }
  const cachedPath = await cacheInstaller(tdl.installerPath, version);
  await saveTorrentSeedInfo({ version, installerPath: cachedPath, torrentPath: tdl.torrentPath });
  const queued = await queuePendingUpdate({ version, installerPath: cachedPath, expectedName: manifest.fileName });
  if (!queued.ok) {
    setUpdateState({ state: 'error', source: 'torrent', version, message: queued.error });
    return;
  }
  setUpdateState({
    state: 'downloaded',
    source: 'torrent',
    version,
    progress: 100,
    message: 'Обновление скачано. Установится после перезапуска.',
  });
}

export function startBackgroundUpdatePolling(opts: { intervalMs?: number } = {}) {
  const intervalMs = Math.max(5 * 60_000, opts.intervalMs ?? 30 * 60_000);
  setTimeout(() => void tick(), 90_000);
  setInterval(() => void tick(), intervalMs);

  async function tick() {
    if (updateInFlight || backgroundInFlight) return;
    const pending = await readPendingUpdate();
    if (!app.isPackaged) return;
    backgroundInFlight = true;
    const lockAcquired = await acquireUpdateLock('background');
    if (!lockAcquired) {
      backgroundInFlight = false;
      return;
    }
    try {
      const netState = getNetworkState();
      if (!netState.online) {
        setUpdateState({ state: 'error', source: 'torrent', message: 'Нет сети, повторим позже.' });
        return;
      }
      setUpdateState({ state: 'checking', source: 'torrent', message: 'Проверяем обновления (torrent)…' });
      const baseUrl = getUpdateApiBaseUrl();
      const manifest = await fetchTorrentManifest(baseUrl);
      if (!manifest) {
        setUpdateState({ state: 'idle' });
        return;
      }
      const current = app.getVersion();
      const updateAvailable = compareSemver(manifest.version, current) > 0;
      if (!updateAvailable) {
        setUpdateState({ state: 'idle' });
        return;
      }
      if (pending?.version && compareSemver(manifest.version, pending.version) <= 0) {
        setUpdateState({
          state: 'downloaded',
          source: 'torrent',
          version: pending.version,
          progress: 100,
          message: 'Обновление скачано. Установится после перезапуска.',
        });
        return;
      }
      const prepared = { ...manifest, torrentUrl: buildTorrentManifestUrl(baseUrl, manifest.torrentUrl) };
      await backgroundTorrentDownload(prepared, manifest.version);
    } catch (e) {
      setUpdateState({ state: 'error', source: 'torrent', message: String(e) });
    } finally {
      backgroundInFlight = false;
      await releaseUpdateLock();
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
    const serverVersion = await getServerVersion();
    const local = await resolveLocalInstaller(current, serverVersion);
    if (local.action === 'install') {
      await installNow({ installerPath: local.installerPath, version: local.version });
      return { action: 'update_started' };
    }

    await stageUpdate('Проверяем торрент-обновления…', 2);
    const torrentCheck = await checkTorrentForUpdates();
    let torrentManifest: TorrentUpdateManifest | null = null;
    if (torrentCheck.ok && torrentCheck.updateAvailable && torrentCheck.manifest) {
      torrentManifest = torrentCheck.manifest;
      await stageUpdate(`Найдена новая версия (Torrent). Подключаемся…`, 5, torrentCheck.version);
      await stopTorrentSeeding().catch(() => {});
      await stopTorrentDownload().catch(() => {});
      await cleanupUpdateCache(torrentCheck.version ?? torrentManifest.version);
      const tdl = await downloadTorrentUpdate(torrentManifest, {
        onProgress: (pct, peers) => {
          void setUpdateUi(`Скачиваем (Torrent)… Пиры: ${peers}`, pct, torrentCheck.version);
        },
        onStats: (stats) => {
          void setTorrentDebug(stats);
        },
      });
      if (tdl.ok) {
        const cachedPath = await cacheInstaller(tdl.installerPath, torrentCheck.version);
        lastDownloadedInstallerPath = cachedPath;
        await saveTorrentSeedInfo({ version: torrentManifest.version, installerPath: cachedPath, torrentPath: tdl.torrentPath });
        await installNow({ installerPath: cachedPath, version: torrentCheck.version ?? torrentManifest.version });
        return { action: 'update_started' };
      }
      if (shouldHoldSource(tdl.error)) {
        await stageUpdate(`Сеть меняется, повторяем Torrent…`, 12, torrentCheck.version);
        const retry = await downloadTorrentUpdate(torrentManifest, {
          onProgress: (pct, peers) => {
            void setUpdateUi(`Скачиваем (Torrent)… Пиры: ${peers}`, pct, torrentCheck.version);
          },
          onStats: (stats) => {
            void setTorrentDebug(stats);
          },
        });
        if (retry.ok) {
          const cachedPath = await cacheInstaller(retry.installerPath, torrentCheck.version);
          lastDownloadedInstallerPath = cachedPath;
          await saveTorrentSeedInfo({ version: torrentManifest.version, installerPath: cachedPath, torrentPath: retry.torrentPath });
          await installNow({ installerPath: cachedPath, version: torrentCheck.version ?? torrentManifest.version });
          return { action: 'update_started' };
        }
      }
      await stageUpdate(`Торрент недоступен, пробуем GitHub…`, 15, torrentCheck.version);
    } else if (!torrentCheck.ok) {
      await stageUpdate(`Торрент недоступен (${torrentCheck.error}). Пробуем GitHub…`, 15);
    } else {
      await stageUpdate('Торрент обновлений не найден. Пробуем GitHub…', 15);
    }

    await setTorrentDebug(null);
    await stageUpdate('Проверяем обновления через GitHub…', 20);
    const check = await waitForUpdateCheck();
    if (check.ok && check.updateAvailable) {
      await stageUpdate(`Найдена новая версия (GitHub). Скачиваем…`, 5, check.version);
      await stopTorrentSeeding().catch(() => {});
      await stopTorrentDownload().catch(() => {});
      await cleanupUpdateCache(check.version ?? 'latest');
      const download = await downloadUpdate(check.version);
      if (!download.ok || !download.filePath) {
        await setUpdateUi(`Ошибка скачивания: ${download.error ?? 'unknown'}`, 100, check.version);
        closeUpdateWindowSoon(3500);
        return { action: 'error', error: download.error ?? 'download failed' };
      }
      const cachedPath = await cacheInstaller(download.filePath, check.version);
      lastDownloadedInstallerPath = cachedPath;
      await ensureTorrentSeedArtifacts(torrentManifest, cachedPath, check.version);
      await installNow({ installerPath: cachedPath, version: check.version });
      return { action: 'update_started' };
    }

    const gh = await checkGithubReleaseForUpdates();
    if (gh.ok && gh.updateAvailable && gh.downloadUrl) {
      await stageUpdate(`Найдена новая версия (GitHub). Скачиваем…`, 5, gh.version);
      await stopTorrentSeeding().catch(() => {});
      await stopTorrentDownload().catch(() => {});
      await cleanupUpdateCache(gh.version ?? 'latest');
      const gdl = await downloadGithubUpdate(gh.downloadUrl, gh.version, {
        onProgress: (pct) => {
          void setUpdateUi(`Скачиваем (GitHub)…`, pct, gh.version);
        },
      });
      if (!gdl.ok || !gdl.filePath) {
        await setUpdateUi(`Ошибка скачивания: ${gdl.error ?? 'unknown'}`, 100, gh.version);
        closeUpdateWindowSoon(3500);
        return { action: 'error', error: gdl.error ?? 'download failed' };
      }
      const cachedPath = await cacheInstaller(gdl.filePath, gh.version);
      lastDownloadedInstallerPath = cachedPath;
      await ensureTorrentSeedArtifacts(torrentManifest, cachedPath, gh.version);
      await installNow({ installerPath: cachedPath, version: gh.version });
      return { action: 'update_started' };
    }

    await stageUpdate('Проверяем Яндекс.Диск…', 30);
    const fallback = await checkYandexForUpdates();
    if (!fallback.ok) {
      if (!check.ok && !gh.ok) {
        await setUpdateUi(`Ошибка проверки: ${check.error}`, 0);
        closeUpdateWindowSoon(3500);
        return { action: 'error', error: check.error };
      }
      await stageUpdate('Обновлений нет. Запускаем приложение…', 100);
      closeUpdateWindowSoon(700);
      return { action: 'no_update' };
    }
    if (!fallback.updateAvailable) {
      await stageUpdate('Обновлений нет. Запускаем приложение…', 100);
      closeUpdateWindowSoon(700);
      return { action: 'no_update' };
    }
    await stageUpdate(`Найдена новая версия (Yandex). Скачиваем…`, 5, fallback.version);
    await stopTorrentSeeding().catch(() => {});
    await stopTorrentDownload().catch(() => {});
    await cleanupUpdateCache(fallback.version ?? 'latest');
    const ydl = await downloadYandexUpdate(fallback, {
      onProgress: (pct) => {
        void setUpdateUi(`Скачиваем (Yandex)…`, pct, fallback.version);
      },
    });
    if (!ydl.ok || !ydl.filePath) {
      await setUpdateUi(`Ошибка скачивания: ${ydl.error ?? 'unknown'}`, 100, fallback.version);
      closeUpdateWindowSoon(3500);
      return { action: 'error', error: ydl.error ?? 'download failed' };
    }
    const cachedPath = await cacheInstaller(ydl.filePath, fallback.version);
    lastDownloadedInstallerPath = cachedPath;
    await ensureTorrentSeedArtifacts(torrentManifest, cachedPath, fallback.version);
    await installNow({ installerPath: cachedPath, version: fallback.version });
    return { action: 'update_started' };
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
    const torrent = await checkTorrentForUpdates();
    if (torrent.ok && torrent.updateAvailable) {
      return { ok: true, updateAvailable: true, version: torrent.version, source: 'torrent' };
    }
    const result = await autoUpdater.checkForUpdates();
    const latest = String((result as any)?.updateInfo?.version ?? '');
    const current = app.getVersion();
    const updateAvailable = latest ? compareSemver(latest, current) > 0 : false;
    if (updateAvailable) return { ok: true, updateAvailable, version: latest || undefined, source: 'github' };
    const gh = await checkGithubReleaseForUpdates();
    if (gh.ok && gh.updateAvailable) return gh;
    const y = await checkYandexForUpdates();
    if (y.ok) return y;
    return { ok: true, updateAvailable: false };
  } catch (e) {
    const torrent = await checkTorrentForUpdates().catch(() => null);
    if (torrent && torrent.ok && torrent.updateAvailable) {
      return { ok: true, updateAvailable: true, version: torrent.version, source: 'torrent' };
    }
    const gh = await checkGithubReleaseForUpdates().catch(() => null);
    if (gh) return gh;
    const y = await checkYandexForUpdates().catch(() => null);
    if (y) return y;
    return { ok: false, error: String(e) };
  }
}

export async function runUpdateHelperFlow(args: UpdateHelperArgs): Promise<void> {
  try {
    showUpdateWindow(null);
    lockUpdateUi(true);
    await writeUpdaterLog(`update-helper flow start version=${args.version ?? 'unknown'} installer=${args.installerPath}`);
    if (args.parentPid) {
      await writeUpdaterLog(`update-helper waiting for parent pid=${args.parentPid}`);
      await setUpdateUi('Ожидаем закрытия программы…', 72, args.version);
      const startedAt = Date.now();
      let lastLogAt = 0;
      while (isProcessAlive(args.parentPid)) {
        const now = Date.now();
        if (now - lastLogAt > 5000) {
          await writeUpdaterLog(`update-helper waiting: parent still running (${Math.round((now - startedAt) / 1000)}s)`);
          lastLogAt = now;
        }
        await sleep(1000);
      }
      await writeUpdaterLog(`update-helper parent exited after ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }
    await setUpdateUi('Подготовка установки…', 70, args.version);
    await sleep(800);
    await setUpdateUi('Запускаем установку…', 80, args.version);
    await writeUpdaterLog(`update-helper launching installer (detached)`);
    const ok = await spawnInstallerDetached(args.installerPath, 1400);
    if (!ok) {
      await writeUpdaterLog('installer launch failed, returning to app');
      await setUpdateUi('Ошибка запуска установщика. Возвращаемся в приложение…', 100, args.version);
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

let lastDownloadedInstallerPath: string | null = null;

type YandexUpdateInfo = { ok: true; updateAvailable: boolean; version?: string; path?: string; source: 'yandex' } | { ok: false; error: string };
type YandexConfig = { publicKey: string; basePath: string };
type GithubReleaseInfo =
  | { ok: true; updateAvailable: boolean; version?: string; downloadUrl?: string; source: 'github' }
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
  return { owner: m[1], repo: m[2] };
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

async function listPublicFolder(publicKey: string, pathOnDisk: string): Promise<string[]> {
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
  return items.map((x) => String(x?.name ?? '')).filter(Boolean);
}

function extractVersionFromFileName(fileName: string): string | null {
  const m = fileName.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function pickNewestInstaller(items: string[]): string | null {
  const exes = items.filter((n) => n.toLowerCase().endsWith('.exe'));
  if (exes.length === 0) return null;
  const preferred = exes.filter((n) => isSetupInstallerName(n));
  const candidates = preferred.length > 0 ? preferred : exes;
  const parsed = candidates
    .map((n) => ({ n, v: extractVersionFromFileName(n) }))
    .filter((x) => x.v);
  if (parsed.length === 0) return candidates[0];
  parsed.sort((a, b) => compareSemver(b.v!, a.v!));
  return parsed[0].n;
}

// download helper moved to netFetch.ts

function parseLatestYml(text: string): { version?: string; path?: string } {
  const ver = text.match(/^version:\s*["']?([^\n"']+)["']?/m)?.[1];
  const path = text.match(/^path:\s*["']?([^\n"']+)["']?/m)?.[1];
  return { version: ver?.trim(), path: path?.trim() };
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
          return { ok: true, updateAvailable, version: latest, path: parsed.path, source: 'yandex' };
        }
      }
    }

    const items = await listPublicFolder(publicKey, basePath);
    const exe = pickNewestInstaller(items);
    if (!exe) return { ok: false, error: 'no installer found in yandex folder' };
    await writeUpdaterLog(`yandex pick installer=${exe}`);
    const version = extractVersionFromFileName(exe);
    if (!version) return { ok: false, error: 'cannot extract version from installer name' };
    const current = app.getVersion();
    const updateAvailable = compareSemver(version, current) > 0;
    return { ok: true, updateAvailable, version, path: exe, source: 'yandex' };
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
      { attempts: 3, timeoutMs: 10_000, backoffMs: 600, maxBackoffMs: 4000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
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
      .map((a: any) => a as { name: string; browser_download_url?: string });
    const preferred = exeCandidates.find((a) => isSetupInstallerName(a.name));
    const exe = preferred ?? exeCandidates[0];
    const downloadUrl = exe?.browser_download_url ? String(exe.browser_download_url) : undefined;
    if (!downloadUrl) return { ok: false, error: 'github release missing exe asset' };
    await writeUpdaterLog(`github pick installer=${exe?.name ?? 'unknown'}`);
    return { ok: true, updateAvailable: true, version, downloadUrl, source: 'github' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function downloadYandexUpdate(
  info: { version?: string; path?: string },
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
      fileName = exe;
    }
    const filePath = joinPosix(basePath, fileName);
    const href = await getYandexDownloadHref(publicKey, filePath);
    if (!href) return { ok: false as const, error: 'yandex installer not found' };
    const outDir = join(tmpdir(), 'MatricaRMZ-Updates');
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, fileName);
    return await downloadWithResume(href, outPath, {
      attempts: 4,
      timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
      backoffMs: 800,
      maxBackoffMs: 6000,
      jitterMs: 300,
      onProgress: opts?.onProgress,
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
    const outDir = join(tmpdir(), 'MatricaRMZ-Updates');
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, fileName);
    return await downloadWithResume(url, outPath, {
      attempts: 4,
      timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
      backoffMs: 800,
      maxBackoffMs: 6000,
      jitterMs: 300,
      onProgress: opts?.onProgress,
    });
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

async function waitForUpdateCheck(): Promise<UpdateCheckResult> {
  return await new Promise<UpdateCheckResult>((resolve) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve({ ok: false, error: 'update check timeout' });
    }, UPDATE_CHECK_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeoutId);
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('error', onError);
    };
    const onAvailable = (info: any) => {
      cleanup();
      const version = String(info?.version ?? '') || undefined;
      const current = app.getVersion();
      if (!version || compareSemver(version, current) <= 0) {
        void writeUpdaterLog(`autoUpdater reports ${version ?? 'unknown'} <= current ${current}`);
        resolve({ ok: true, updateAvailable: false });
        return;
      }
      void writeUpdaterLog(`autoUpdater update available=${version} current=${current}`);
      resolve({ ok: true, updateAvailable: true, version, source: 'github' });
    };
    const onNotAvailable = () => {
      cleanup();
      resolve({ ok: true, updateAvailable: false });
    };
    const onError = (err: any) => {
      cleanup();
      resolve({ ok: false, error: String(err) });
    };
    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('error', onError);
    autoUpdater.checkForUpdates().catch(onError);
  });
}

async function downloadUpdate(version?: string): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  return await new Promise((resolve) => {
    const cleanup = () => {
      autoUpdater.removeListener('download-progress', onProgress);
      autoUpdater.removeListener('update-downloaded', onDownloaded);
      autoUpdater.removeListener('error', onError);
    };
    const onProgress = (p: any) => {
      const pct = typeof p?.percent === 'number' ? p.percent : 0;
      void setUpdateUi('Скачиваем обновление…', pct, version);
    };
    const onDownloaded = (info: any) => {
      cleanup();
      const filePath =
        (info as any)?.downloadedFile ||
        (info as any)?.files?.[0]?.path ||
        (info as any)?.path ||
        null;
      if (!filePath) {
        resolve({ ok: false, error: 'missing downloaded file path' });
        return;
      }
      resolve({ ok: true, filePath: String(filePath) });
    };
    const onError = (err: any) => {
      cleanup();
      resolve({ ok: false, error: String(err) });
    };
    autoUpdater.on('download-progress', onProgress);
    autoUpdater.once('update-downloaded', onDownloaded);
    autoUpdater.once('error', onError);
    autoUpdater.downloadUpdate().catch(onError);
  });
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

async function runInstaller(installerPath: string): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(installerPath, [], { windowsHide: false, stdio: 'ignore' });
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
}

async function spawnInstallerDetached(installerPath: string, delayMs = 1200): Promise<boolean> {
  const delay = Math.max(200, delayMs);
  await writeUpdaterLog(`installer launch scheduled in ${Math.round(delay / 1000)}s`);
  await sleep(delay);
  try {
    const child = spawn(installerPath, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      child.once('spawn', () => {
        void writeUpdaterLog('installer spawned (detached)');
        finish(true);
      });
      child.once('error', (err) => {
        void writeUpdaterLog(`installer spawn error: ${String(err)}`);
        finish(false);
      });
      setTimeout(() => finish(true), 200);
    });
  } catch (e) {
    await writeUpdaterLog(`installer spawn exception: ${String(e)}`);
    return false;
  }
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


