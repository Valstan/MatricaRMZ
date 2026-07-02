import { app, BrowserWindow, dialog, shell } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, stat, writeFile, access, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { formatCalverBuildDate } from '@matricarmz/shared';

import { getNetworkState } from './networkService.js';
import { downloadWithResume, fetchWithRetry } from './netFetch.js';
import type { DeltaPlan } from './blockmapDelta.js';
import { deltaAssemblyTempPath, isLaunchableInstallerName } from './installerNaming.js';
import { classifyIntegrityFailure } from './installerIntegrityRecovery.js';
import { extractYandexFolderItems, extractYandexResourceMeta } from './yandexResourceMeta.js';
import { getUpdatesRootDir, setConfiguredUpdatesRootDir } from './updatePaths.js';
import { SettingsKey, settingsGetString, settingsSetString } from './settingsStore.js';
import {
  getLanServerPort,
  getLocalLanPeers,
  isLanUpdateEnabled,
  listLanPeers,
  listUpdatePeers,
  registerLanPeers,
  registerUpdatePeers,
  startLanUpdateServer,
} from './lanUpdateService.js';
import { getSession } from './authService.js';
import { setForceQuit } from '../index.js';

export type UpdateCheckResult =
  | {
      ok: true;
      updateAvailable: boolean;
      version?: string;
      source?: 'github' | 'yandex' | 'lan' | 'torrent' | 'server';
      downloadUrl?: string;
      expectedSize?: number | null;
      expectedSha?: string | null;
    }
  | { ok: false; error: string };

export type UpdateFlowResult =
  | { action: 'no_update' }
  | { action: 'update_started' }
  | { action: 'update_downloaded'; version?: string; source?: 'github' | 'yandex' | 'lan' | 'torrent' | 'server' }
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
const FIXED_UPDATE_INSTALLER_NAME = 'matrica_rmz_update.exe';
const INTEGRITY_RECOVERY_HINT =
  'Установщик не прошёл проверку целостности. Программа сама докачает его заново и повторит установку при следующем запуске — вмешательство не требуется.';

export function initAutoUpdate() {
  // kept for backward compatibility; no autoUpdater wiring needed
}

let updateInFlight = false;
let backgroundInFlight = false;
let updateUiWindow: BrowserWindow | null = null;
let updateUiLocked = false;
const updateLog: string[] = [];
type UpdateStage = 'checking' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'uptodate' | 'error';
type UpdateUiViewState = {
  message: string;
  pct: number;
  version: string;
  logs: string[];
  stage: UpdateStage;
  transferredBytes: number | null;
  totalBytes: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  deltaFullBytes: number | null;
  versionFromLabel: string;
  versionToLabel: string;
  errorText: string | null;
};
function freshUpdateUiViewState(): UpdateUiViewState {
  return {
    message: 'Проверяем обновления…',
    pct: 0,
    version: '',
    logs: [],
    stage: 'checking',
    transferredBytes: null,
    totalBytes: null,
    bytesPerSecond: null,
    etaSeconds: null,
    deltaFullBytes: null,
    versionFromLabel: '',
    versionToLabel: '',
    errorText: null,
  };
}
type UpdateUiOpts = { stage?: UpdateStage; transferredBytes?: number | null; totalBytes?: number | null; deltaFullBytes?: number | null; errorText?: string | null };
let updateUiViewState: UpdateUiViewState = freshUpdateUiViewState();
// Для расчёта скорости/ETA загрузки из дельт transferred. Скорость считаем как среднюю
// за окно SPEED_WINDOW_MS + EMA-сглаживание, а высокочастотные прогресс-пуши коалесцируем
// до этого же окна — иначе мгновенная дельта между чанками скачет и цифры «мельтешат».
let lastProgressBytes = 0;
let lastProgressTs = 0;
const SPEED_WINDOW_MS = 1000;
let lastManualUpdatePromptAt = 0;
const MANUAL_UPDATE_PROMPT_COOLDOWN_MS = 30 * 60_000;

let updateApiBaseUrl = '';
let updateDb: BetterSQLite3Database | null = null;

type UpdateRuntimeState = {
  state: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error';
  source?: 'github' | 'yandex' | 'lan' | 'torrent' | 'server';
  version?: string;
  progress?: number;
  message?: string;
  updatedAt: number;
};

let updateState: UpdateRuntimeState = { state: 'idle', updatedAt: Date.now() };

export function configureUpdateService(opts: { apiBaseUrl?: string; db?: BetterSQLite3Database }) {
  if (opts.apiBaseUrl) updateApiBaseUrl = String(opts.apiBaseUrl).trim();
  if (opts.db) {
    updateDb = opts.db;
    void syncConfiguredUpdateDirFromSettings();
  }
}

// Peer endpoints require auth. Resolve the current session's access token (undefined
// pre-login / logged out) — peer register/list then skip gracefully and the updater
// falls back to the central server. (security-hardening-2026-06, Phase 3)
async function getUpdateAccessToken(): Promise<string | undefined> {
  if (!updateDb) return undefined;
  const session = await getSession(updateDb).catch(() => null);
  return session?.accessToken || undefined;
}

async function syncConfiguredUpdateDirFromSettings(): Promise<void> {
  if (!updateDb) return;
  try {
    const next = String((await settingsGetString(updateDb, SettingsKey.UpdatesDownloadDir)) ?? '').trim();
    setConfiguredUpdatesRootDir(next || null);
  } catch {
    // ignore
  }
}

export async function getUpdateDownloadDir(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    await syncConfiguredUpdateDirFromSettings();
    return { ok: true, path: getUpdatesRootDir() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function setUpdateDownloadDir(path: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const next = String(path ?? '').trim();
    if (!next) return { ok: false, error: 'path is empty' };
    if (!updateDb) return { ok: false, error: 'settings db is not ready' };
    setConfiguredUpdatesRootDir(next);
    await settingsSetString(updateDb, SettingsKey.UpdatesDownloadDir, next);
    return { ok: true, path: next };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
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

function resolveUpdateUiPreloadPath(): string | null {
  const appPath = app.getAppPath();
  const candidates = [
    join(appPath, 'dist/preload/update.cjs'),
    join(appPath, 'dist/preload/update.js'),
    join(appPath, 'dist/preload/update.mjs'),
    join(process.resourcesPath, 'app/dist/preload/update.cjs'),
    join(process.resourcesPath, 'app/dist/preload/update.js'),
    join(process.resourcesPath, 'app/dist/preload/update.mjs'),
    join(process.resourcesPath, 'app.asar/dist/preload/update.cjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveUpdateUiHtmlPath(): string | null {
  const appPath = app.getAppPath();
  const candidates = [
    join(appPath, 'dist/renderer/update.html'),
    join(process.resourcesPath, 'app/dist/renderer/update.html'),
    join(process.resourcesPath, 'app.asar/dist/renderer/update.html'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function pushUpdateUiState() {
  const w = updateUiWindow;
  if (!w || w.isDestroyed()) return;
  w.webContents.send('update:state', updateUiViewState);
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
  void expectedName;
  const st = await stat(installerPath).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, error: 'installer file is missing' };
  if (st.size <= 0) return { ok: false, error: 'installer file is empty' };
  if (expectedSize && Number.isFinite(expectedSize) && st.size !== expectedSize) {
    return { ok: false, error: `installer size mismatch: expected ${expectedSize} got ${st.size}` };
  }
  const actualName = basename(installerPath);
  if (!isLaunchableInstallerName(actualName)) {
    return { ok: false, error: `installer mismatch: expected .exe, got ${actualName}` };
  }
  const actualIsSetup = isSetupInstallerName(actualName);
  return { ok: true, isSetup: actualIsSetup, size: st.size, actualName };
}

type ServerUpdateMeta = {
  version: string;
  fileName: string;
  size: number;
  sha256?: string;
  blockmapFileName?: string;
};

type ServerTorrentMeta = {
  version: string;
  fileName: string;
  size: number;
  infoHash: string;
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

async function readFilePrefix(filePath: string, byteCount: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start: 0, end: Math.max(0, byteCount - 1) });
    stream.on('error', reject);
    stream.on('data', (chunk: string | Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function validateInstallerBinarySignature(
  installerPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const prefix = await readFilePrefix(installerPath, 2);
    const looksLikeExe = prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a; // "MZ"
    if (!looksLikeExe) {
      return { ok: false, error: 'installer binary signature mismatch (expected MZ header)' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `installer signature check failed: ${String(e)}` };
  }
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
    const blockmapFileName = String(json.blockmapFileName ?? '').trim();
    if (!version || !fileName || !Number.isFinite(size) || size <= 0) return null;
    return { version, fileName, size, ...(sha256 ? { sha256 } : {}), ...(blockmapFileName ? { blockmapFileName } : {}) };
  } catch {
    return null;
  }
}

async function resolvePublishedServerUpdate(
  currentVersion: string,
  existingServerMeta?: ServerUpdateMeta | null,
): Promise<{ serverMeta: ServerUpdateMeta; torrentMeta: ServerTorrentMeta | null } | null> {
  const serverMeta = existingServerMeta ?? (await fetchLatestUpdateMetaFromServer());
  if (!serverMeta) return null;
  if (compareSemver(serverMeta.version, currentVersion) <= 0) {
    void tryAdvertiseLan(serverMeta).catch(() => {});
    return null;
  }

  const torrentLatest = await fetchLatestTorrentFromServer();
  const torrentMeta =
    torrentLatest.ok &&
    torrentLatest.updateAvailable &&
    torrentLatest.version === serverMeta.version &&
    torrentLatest.fileName === serverMeta.fileName &&
    torrentLatest.infoHash &&
    Number.isFinite(Number(torrentLatest.size ?? 0)) &&
    Number(torrentLatest.size ?? 0) > 0
      ? {
          version: torrentLatest.version,
          fileName: torrentLatest.fileName,
          size: Number(torrentLatest.size),
          infoHash: torrentLatest.infoHash,
          ...(serverMeta.sha256 ? { sha256: serverMeta.sha256 } : {}),
        }
      : null;

  return { serverMeta, torrentMeta };
}

async function getExpectedShaForVersion(version?: string | null): Promise<string | null> {
  const safeVersion = String(version ?? '').trim();
  if (!safeVersion) return null;
  const serverMeta = await fetchLatestUpdateMetaFromServer().catch(() => null);
  if (!serverMeta || serverMeta.version !== safeVersion) return null;
  return serverMeta.sha256 ?? null;
}

async function findCachedInstallerForVersion(
  version: string,
  expectedName?: string,
): Promise<{ filePath: string; fileName: string } | null> {
  const pending = await readPendingUpdate();
  if (pending?.version && pending.version === version) {
    const pendingValidation = await validateInstallerPath(
      pending.installerPath,
      expectedName ?? pending.installerPath,
      pending.expectedSize ?? null,
    );
    if (pendingValidation.ok) {
      return { filePath: pending.installerPath, fileName: basename(pending.installerPath) };
    }
  }
  const stablePath = getStableInstallerPath();
  const stableValidation = await validateInstallerPath(stablePath, expectedName ?? stablePath);
  if (!stableValidation.ok) return null;
  return { filePath: stablePath, fileName: basename(stablePath) };
}

async function validateInstallerIntegrity(
  installerPath: string,
  expectedName: string,
  expectedSize: number,
  expectedSha?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const basic = await validateInstallerPath(installerPath, expectedName, expectedSize);
  if (!basic.ok) return basic;
  const binary = await validateInstallerBinarySignature(installerPath);
  if (!binary.ok) return binary;
  if (expectedSha) {
    const actual = await computeSha256(installerPath);
    if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
      return { ok: false, error: 'installer sha256 mismatch' };
    }
  }
  return { ok: true };
}

async function validateInstallerBeforeLaunch(args: {
  installerPath: string;
  expectedSize?: number | null;
  expectedSha?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const basic = await validateInstallerPath(args.installerPath, args.installerPath, args.expectedSize ?? null);
  if (!basic.ok) return basic;
  const binary = await validateInstallerBinarySignature(args.installerPath);
  if (!binary.ok) return binary;
  const expectedSha = String(args.expectedSha ?? '').trim();
  if (expectedSha) {
    const actualSha = await computeSha256(args.installerPath);
    if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
      return { ok: false, error: 'installer sha256 mismatch' };
    }
  }
  return { ok: true };
}

async function ensureInstallerReadyForInstall(args: {
  installerPath: string;
  version?: string;
  expectedSize?: number | null;
  expectedSha?: string | null;
  downloadUrl?: string | null;
}): Promise<{ ok: true; expectedSize?: number | null; expectedSha?: string | null } | { ok: false; error: string }> {
  let expectedSize = args.expectedSize ?? null;
  let expectedSha = args.expectedSha ?? null;

  // If pending metadata is incomplete, try to enrich from server meta.
  if (args.version && (expectedSize == null || !expectedSha)) {
    const meta = await fetchLatestUpdateMetaFromServer();
    if (meta && meta.version === args.version) {
      if (expectedSize == null) expectedSize = meta.size;
      if (!expectedSha && meta.sha256) expectedSha = meta.sha256;
    }
  }

  const initialCheck = await validateInstallerBeforeLaunch({
    installerPath: args.installerPath,
    expectedSize,
    expectedSha,
  });
  if (initialCheck.ok) return { ok: true, expectedSize, expectedSha };

  await writeUpdaterLog(`installer integrity failed before launch: ${initialCheck.error}`);
  const downloadUrl = String(args.downloadUrl ?? '').trim();
  const canRedownload = /^https?:\/\//i.test(downloadUrl);
  if (!canRedownload) {
    await rm(args.installerPath, { force: true }).catch(() => {});
    return { ok: false, error: initialCheck.error };
  }

  // Classify the failure so we don't waste time on a meaningless resume
  // when the cached file is fully downloaded but stale (size matches,
  // content differs — Range resume yields zero bytes).
  const actualSize = await stat(args.installerPath)
    .then((s) => Number(s.size ?? 0))
    .catch(() => null);
  const decision = classifyIntegrityFailure(actualSize, expectedSize);
  await writeUpdaterLog(`installer integrity classify: ${decision.logHint}`);

  if (decision.shouldTryResume) {
    await writeUpdaterLog(`installer integrity repair: resume download start (${downloadUrl})`);
    const resumed = await downloadWithResume(downloadUrl, args.installerPath, {
      attempts: 3,
      timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
      noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
      useBitsOnWindows: false,
      backoffMs: 800,
      maxBackoffMs: 6000,
      jitterMs: 300,
    });
    if (resumed.ok && resumed.filePath) {
      const resumeCheck = await validateInstallerBeforeLaunch({
        installerPath: args.installerPath,
        expectedSize,
        expectedSha,
      });
      if (resumeCheck.ok) return { ok: true, expectedSize, expectedSha };
      await writeUpdaterLog(`installer integrity failed after resume: ${resumeCheck.error}`);
    } else {
      await writeUpdaterLog(`installer resume failed: ${resumed.error ?? 'download failed'}`);
    }
  }

  // Either resume didn't help, or we deliberately skipped it (stale/oversize/unknown):
  // remove the bad file and download from scratch.
  await rm(args.installerPath, { force: true }).catch(() => {});
  await writeUpdaterLog(`installer integrity repair: full re-download start (${downloadUrl})`);
  const redownloaded = await downloadWithResume(downloadUrl, args.installerPath, {
    attempts: 4,
    timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
    noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
    useBitsOnWindows: false,
    backoffMs: 800,
    maxBackoffMs: 6000,
    jitterMs: 300,
  });
  if (!redownloaded.ok || !redownloaded.filePath) {
    await rm(args.installerPath, { force: true }).catch(() => {});
    return { ok: false, error: `installer re-download failed: ${redownloaded.error ?? 'download failed'}` };
  }

  const finalCheck = await validateInstallerBeforeLaunch({
    installerPath: args.installerPath,
    expectedSize,
    expectedSha,
  });
  if (!finalCheck.ok) {
    await rm(args.installerPath, { force: true }).catch(() => {});
    return { ok: false, error: `installer corrupted after re-download: ${finalCheck.error}` };
  }
  return { ok: true, expectedSize, expectedSha };
}

async function queuePendingUpdate(args: {
  version: string;
  installerPath: string;
  expectedName?: string;
  expectedSize?: number | null;
  expectedSha?: string | null;
  downloadUrl?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const validation = await validateInstallerPath(args.installerPath, args.expectedName, args.expectedSize ?? null);
  if (!validation.ok) return validation;
  await writePendingUpdate({
    version: args.version,
    installerPath: args.installerPath,
    expectedSize: args.expectedSize ?? null,
    expectedSha: args.expectedSha ?? null,
    downloadUrl: args.downloadUrl ?? null,
  });
  await writeUpdaterLog(
    `pending-update saved version=${args.version} installer=${args.installerPath} size=${validation.size}`,
  );
  return { ok: true };
}

async function installNow(args: { installerPath: string; version?: string }) {
  await stageUpdate('Скачивание завершено. Проверяем целостность установщика…', 60, args.version, { stage: 'verifying' });
  lockUpdateUi(true);
  await stageUpdate('Подготовка установщика…', 70, args.version, { stage: 'verifying' });
  const pending = await readPendingUpdate();
  const pendingForInstaller =
    pending && pending.installerPath === args.installerPath ? pending : null;
  const resolvedVersion = args.version ?? pendingForInstaller?.version;
  const ready = await ensureInstallerReadyForInstall({
    installerPath: args.installerPath,
    ...(resolvedVersion != null ? { version: resolvedVersion } : {}),
    expectedSize: pendingForInstaller?.expectedSize ?? null,
    expectedSha: pendingForInstaller?.expectedSha ?? null,
    downloadUrl: pendingForInstaller?.downloadUrl ?? null,
  });
  if (!ready.ok) {
    await writeUpdaterLog(`installer validation failed: ${ready.error}`);
    if (pendingForInstaller) await clearPendingUpdate();
    await stageUpdate('Установщик поврежден. Повторим позже.', 100, args.version, {
      stage: 'error',
      errorText: INTEGRITY_RECOVERY_HINT,
    });
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
    await writePendingUpdate({
      version: args.version ?? pendingForInstaller?.version ?? 'unknown',
      installerPath: args.installerPath,
      expectedSize: pendingForInstaller?.expectedSize ?? ready.expectedSize ?? null,
      expectedSha: pendingForInstaller?.expectedSha ?? ready.expectedSha ?? null,
      downloadUrl: pendingForInstaller?.downloadUrl ?? null,
    });
    await stageUpdate('Не удалось запустить установщик. Повторим при следующем запуске.', 100, args.version, {
      stage: 'error',
      errorText: 'Не удалось запустить установщик. Программа повторит установку при следующем запуске.',
    });
    closeUpdateWindowSoon(4000);
    return;
  }
  await stageUpdate('Запускаем установку…', 80, args.version, { stage: 'installing' });
  // Helper spawned successfully — the installer will replace this app.
  // Drop pending-update.json so the NEXT boot of the freshly-installed
  // version doesn't see a stale expectedSha from the *previous* update
  // attempt. (F8 in the updater refactor plan.)
  await clearPendingUpdate().catch(() => {});
  await writeUpdaterLog('pending-update cleared after helper spawned');
  await recordUpdateOutcome({
    toVersion: resolvedVersion ?? args.version ?? null,
    downloadUrl: pendingForInstaller?.downloadUrl ?? null,
    fullBytes: pendingForInstaller?.expectedSize ?? ready.expectedSize ?? null,
  });
  await setUpdateUi('Перезапускаем программу…', 100, args.version, { stage: 'restarting' });
  quitMainAppSoon();
}

async function renderUpdateLog() {
  const w = updateUiWindow;
  if (!w || w.isDestroyed()) return;
  updateUiViewState = { ...updateUiViewState, logs: [...updateLog] };
  pushUpdateUiState();
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
  lastProgressBytes = 0;
  lastProgressTs = 0;
  updateUiViewState = freshUpdateUiViewState();
  const preloadPath = resolveUpdateUiPreloadPath();
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
      ...(preloadPath ? { preload: preloadPath } : {}),
    },
  });
  if (preloadPath) {
    void writeUpdaterLog(`update-ui preload=${preloadPath}`);
  } else {
    void writeUpdaterLog('update-ui preload not found, fallback mode');
  }
  updateUiWindow.setMenuBarVisibility(false);
  updateUiWindow.on('close', (e) => {
    if (updateUiLocked) e.preventDefault();
  });
  const htmlPath = resolveUpdateUiHtmlPath();
  if (htmlPath) {
    void writeUpdaterLog(`update-ui html=${htmlPath}`);
    // loadFile() trips a known Electron bug on Windows when the html
    // sits inside an .asar archive — Chromium reports ERR_FAILED (-2)
    // even though existsSync() and the asar reader can see the file.
    // Building the file:// URL ourselves and using loadURL bypasses
    // that path resolution and works in both packaged and dev builds.
    const fileUrl = `file:///${htmlPath.replaceAll('\\', '/')}`;
    void updateUiWindow.loadURL(fileUrl).catch((e) => {
      void writeUpdaterLog(`update-ui loadURL error: ${String(e)}`);
    });
  } else {
    void writeUpdaterLog('update-ui html not found, fallback to about:blank');
    void updateUiWindow.loadURL('about:blank');
  }
  updateUiWindow.webContents.on('did-finish-load', () => {
    pushUpdateUiState();
  });
  return updateUiWindow;
}

// Dev-only: прогон окна обновления по всем стадиям без реального релиза.
// Включается env-флагом MATRICA_SIMULATE_UPDATE (в проде не выставлен) — верификация UI.
export async function simulateUpdateUiForDev(scenario: 'happy' | 'error' | 'loop' = 'happy'): Promise<void> {
  showUpdateWindow();
  if (scenario === 'loop') {
    for (let n = 0; ; n += 1) {
      await runUpdateSimOnce(n % 2 === 0 ? 'happy' : 'error');
      await new Promise((r) => setTimeout(r, 1600));
    }
  }
  await runUpdateSimOnce(scenario);
}

async function runUpdateSimOnce(scenario: 'happy' | 'error'): Promise<void> {
  lastProgressBytes = 0;
  lastProgressTs = 0;
  const v = '2026.614.1530';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await setUpdateUi('Проверяем обновления…', 0, '', { stage: 'checking' });
  await sleep(900);
  // Симулируем delta-режим (основной путь): качается дельта ~9 МБ вместо полного ~110 МБ.
  const fullBytes = 110 * 1024 * 1024;
  const total = 9 * 1024 * 1024;
  await setUpdateUi('Догружаем только изменения…', 0, v, {
    stage: 'downloading',
    transferredBytes: 0,
    totalBytes: total,
    deltaFullBytes: fullBytes,
  });
  for (let i = 1; i <= 20; i += 1) {
    await sleep(150);
    const transferred = Math.round((total * i) / 20);
    await setUpdateUi('Догружаем только изменения…', Math.round((i / 20) * 100), v, {
      stage: 'downloading',
      transferredBytes: transferred,
      totalBytes: total,
      deltaFullBytes: fullBytes,
    });
  }
  await setUpdateUi('Проверяем целостность установщика…', 100, v, { stage: 'verifying' });
  await sleep(1100);
  if (scenario === 'error') {
    await setUpdateUi('Не удалось проверить целостность установщика.', 100, v, {
      stage: 'error',
      errorText:
        'Контрольная сумма не совпала. Программа сама докачает установщик и перезапустится при следующем запуске — вмешательство не требуется.',
    });
    return;
  }
  await setUpdateUi('Устанавливаем обновление…', 100, v, { stage: 'installing' });
  await sleep(1200);
  await setUpdateUi('Перезапускаем программу…', 100, v, { stage: 'restarting' });
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

function quitMainAppSoon(ms = 0) {
  try {
    setForceQuit(true);
  } catch {
    // ignore
  }
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
  }, Math.max(0, ms));
  setTimeout(() => {
    try {
      app.exit(0);
    } catch {
      // ignore
    }
  }, Math.max(ms + 3000, 3000));
}

async function setUpdateUi(msg: string, pct?: number, version?: string, opts?: UpdateUiOpts) {
  const w = updateUiWindow;
  if (!w || w.isDestroyed()) return;
  const nextPct = pct == null ? updateUiViewState.pct : Math.max(0, Math.min(100, Math.floor(pct)));
  const next: UpdateUiViewState = { ...updateUiViewState, message: msg, pct: nextPct };
  if (!next.versionFromLabel) {
    const cur = app.getVersion();
    next.versionFromLabel = formatCalverBuildDate(cur) ?? cur;
  }
  if (version != null && String(version).trim()) {
    next.version = String(version);
    next.versionToLabel = formatCalverBuildDate(next.version) ?? next.version;
  }
  if (opts?.stage) next.stage = opts.stage;
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'errorText')) {
    next.errorText = opts.errorText ?? null;
  }
  // true → высокочастотный прогресс-апдейт внутри окна: копим в стейте, но не пушим в окно.
  let coalesceProgress = false;
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'transferredBytes')) {
    const t = opts.transferredBytes ?? null;
    const total = opts.totalBytes ?? null;
    next.transferredBytes = t;
    next.totalBytes = total;
    const now = Date.now();
    if (t == null) {
      // нет данных о байтах — скорость/ETA не трогаем
    } else if (lastProgressTs === 0) {
      // первый сэмпл: ставим якорь окна (скорость пока неизвестна), но размер показываем сразу
      lastProgressBytes = t;
      lastProgressTs = now;
    } else if (now - lastProgressTs >= SPEED_WINDOW_MS) {
      // граница окна: средняя скорость за окно + EMA-сглаживание поверх прошлой
      const windowRate = t >= lastProgressBytes ? (t - lastProgressBytes) / ((now - lastProgressTs) / 1000) : 0;
      if (windowRate > 0) {
        const prev = updateUiViewState.bytesPerSecond;
        const smoothed = prev != null && prev > 0 ? prev * 0.6 + windowRate * 0.4 : windowRate;
        next.bytesPerSecond = smoothed;
        next.etaSeconds = total != null ? Math.max(0, (total - t) / smoothed) : null;
      }
      lastProgressBytes = t;
      lastProgressTs = now;
    } else {
      // внутри окна: сохраняем последние показанные скорость/ETA и коалесцируем пуш
      next.bytesPerSecond = updateUiViewState.bytesPerSecond;
      next.etaSeconds = updateUiViewState.etaSeconds;
      coalesceProgress = next.stage === 'downloading' && nextPct < 100;
    }
  }
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'deltaFullBytes')) {
    next.deltaFullBytes = opts.deltaFullBytes ?? null;
  }
  updateUiViewState = next;
  // Прогресс внутри окна копим в стейте; пушим на границе окна / при смене стадии / завершении —
  // чтобы текст в окне обновлялся ~раз в секунду, а не на каждый сетевой чанк.
  if (!coalesceProgress) pushUpdateUiState();
}

async function stageUpdate(msg: string, pct?: number, version?: string, opts?: UpdateUiOpts) {
  await addUpdateLog(msg);
  await setUpdateUi(msg, pct, version, opts);
}

async function cacheInstaller(filePath: string, version?: string) {
  void version;
  const outDir = getUpdatesRootDir();
  await mkdir(outDir, { recursive: true });
  const outPath = getStableInstallerPath();
  if (outPath === filePath) return outPath;
  await rm(outPath, { force: true });
  await copyFile(filePath, outPath);
  return outPath;
}

export async function recoverStuckUpdateState(): Promise<void> {
  await syncConfiguredUpdateDirFromSettings();
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
    await syncConfiguredUpdateDirFromSettings();
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
  expectedSha?: string | null;
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
  expectedSha?: string | null;
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
      expectedSha: typeof json.expectedSha === 'string' ? String(json.expectedSha) : null,
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
  const pending = await readPendingUpdate();
  if (!pending?.version || !pending.installerPath) return null;
  const validation = await validateInstallerPath(
    pending.installerPath,
    pending.installerPath,
    pending.expectedSize ?? null,
  );
  if (!validation.ok) return null;
  return { version: pending.version, installerPath: pending.installerPath };
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
    const meta = await fetchLatestUpdateMetaFromServer();
    if (meta?.version) return meta.version;
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
    await getUpdateAccessToken(),
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

  const outPath = await prepareStableInstallerDownloadTarget();

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
}): Promise<'run'> {
  const yandexUrl = args.yandexUrl ? String(args.yandexUrl).trim() : '';
  const instruction =
    'Нажмите на ссылку, чтобы скачать обновление самостоятельно. После скачивания файла, запустите его, программа установится сама. Нажмите ОК чтобы открыть программу для работы, пока скачивается обновление.';
  const details = [
    args.version ? `Версия: ${args.version}` : '',
    args.reason ? `Причина: ${args.reason}` : '',
    yandexUrl ? `Ссылка Яндекс.Диска: ${yandexUrl}` : '',
    '',
    instruction,
  ]
    .filter(Boolean)
    .join('\n');

  await stageUpdate(instruction, 100, args.version);
  lockUpdateUi(false);
  if (yandexUrl) {
    const response = updateUiWindow
      ? await dialog.showMessageBox(updateUiWindow, {
          type: 'warning',
          title: 'Ручное обновление',
          message: 'Открыть ссылку на обновление в браузере?',
          detail: details,
          buttons: ['Открыть ссылку', 'ОК'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
      : await dialog.showMessageBox({
          type: 'warning',
          title: 'Ручное обновление',
          message: 'Открыть ссылку на обновление в браузере?',
          detail: details,
          buttons: ['Открыть ссылку', 'ОК'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
    if (response.response === 0) {
      await shell.openExternal(yandexUrl).catch((e) => writeUpdaterLog(`manual update openExternal failed: ${String(e)}`));
      if (updateUiWindow && !updateUiWindow.isDestroyed()) {
        await dialog.showMessageBox(updateUiWindow, {
          type: 'info',
          title: 'Ручное обновление',
          message: instruction,
          detail: details,
          buttons: ['ОК'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
      } else {
        await dialog.showMessageBox({
          type: 'info',
          title: 'Ручное обновление',
          message: instruction,
          detail: details,
          buttons: ['ОК'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
      }
    }
    return 'run';
  }

  if (updateUiWindow && !updateUiWindow.isDestroyed()) {
    await dialog.showMessageBox(updateUiWindow, {
      type: 'info',
      title: 'Ручное обновление',
      message: instruction,
      detail: details,
      buttons: ['ОК'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } else {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Ручное обновление',
      message: instruction,
      detail: details,
      buttons: ['ОК'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  }
  return 'run';
}

export async function applyPendingUpdateIfAny(parentWindow?: BrowserWindow | null): Promise<boolean> {
  await syncConfiguredUpdateDirFromSettings();
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
  const ready = await ensureInstallerReadyForInstall({
    installerPath: pending.installerPath,
    version: pending.version,
    expectedSize: pending.expectedSize ?? null,
    expectedSha: pending.expectedSha ?? null,
    downloadUrl: pending.downloadUrl ?? null,
  });
  if (!ready.ok) {
    await writeUpdaterLog(`pending-update integrity failed: ${ready.error}`);
    await clearPendingUpdate();
    return false;
  }
  showUpdateWindow(parentWindow ?? null);
  lockUpdateUi(true);
  await setUpdateUi('Найдена скачанная версия. Устанавливаем…', 80, pending.version, { stage: 'installing' });
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
    ...(pending.version != null ? { version: pending.version } : {}),
    parentPid: process.pid,
  });
  if (!spawned) {
    await writeUpdaterLog('update-helper spawn failed, pending update retained');
    await setUpdateUi('Ошибка запуска установщика. Повторим при следующем запуске.', 100, pending.version, {
      stage: 'error',
      errorText: 'Не удалось запустить установщик. Программа повторит установку при следующем запуске.',
    });
    closeUpdateWindowSoon(4000);
    return false;
  }
  await writeUpdaterLog('pending-update cleared after helper spawn');
  await clearPendingUpdate();
  await setUpdateUi('Перезапускаем программу…', 100, pending.version, { stage: 'restarting' });
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
    // Yandex Disk hosts an independently uploaded build whose sha256 may
    // differ from the prod server / GitHub release sha. Validate against
    // the value reported by Yandex itself when available. (F2 root cause.)
    const expectedSha = y.expectedSha ?? null;
    const queued = await queuePendingUpdate({
      version,
      installerPath: cachedPath,
      expectedSize: y.expectedSize ?? null,
      expectedSha,
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
    const expectedSha = await getExpectedShaForVersion(version);
    const queued = await queuePendingUpdate({
      version,
      installerPath: cachedPath,
      expectedSize: gh.expectedSize ?? null,
      expectedSha,
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
    await syncConfiguredUpdateDirFromSettings();
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
        setUpdateState({ state: 'error', message: 'Нет сети, повторим позже.' });
        return;
      }
      const current = app.getVersion();
      let candidateVersion: string | undefined;
      let candidateReason: string | undefined;

      if (pending?.version && compareSemver(pending.version, current) > 0) {
        setUpdateState({
          state: 'downloaded',
          source: 'server',
          version: pending.version,
          progress: 100,
          message: 'Обновление скачано. Установится после перезапуска.',
        });
        return;
      }

      const publishedUpdate = await resolvePublishedServerUpdate(current);
      if (!publishedUpdate) {
        setUpdateState({ state: 'idle' });
        return;
      }
      const { serverMeta, torrentMeta } = publishedUpdate;
      candidateVersion = serverMeta.version;

      // 0) Delta-first: при наличии топлива (кэш installer'а текущей версии + blockmap + sidecar)
      // качаем только изменившиеся блоки с сервера — единицы МБ вместо полного installer'а (~110 МиБ).
      // tryServerDeltaDownload самодостаточно гардирован: нет топлива / sha mismatch / diff>80% /
      // integrity → молча {ok:false}, и мы проходим в обычный полный каскад без изменений.
      // Состояние ставим только в onProgress (он срабатывает лишь когда delta реально идёт),
      // чтобы при отсутствии топлива не мелькало ложное сообщение.
      {
        const apiBaseUrl = await resolveUpdateApiBaseUrl().catch(() => '');
        if (apiBaseUrl) {
          const onDeltaProgress = (_pctAssembly: number, downloaded: number, downloadTotal: number | null) => {
            const dlTotal = downloadTotal ?? null;
            const pctDl = dlTotal && dlTotal > 0 ? Math.max(0, Math.min(100, (downloaded / dlTotal) * 100)) : 0;
            const msg = 'Догружаем только изменения…';
            setUpdateState({
              state: 'downloading',
              source: 'server',
              version: serverMeta.version,
              progress: Math.round(pctDl),
              message: msg,
            });
            // Окно показывает дельту: размер/бар/скорость — по докачке изменений, не по полному installer'у.
            void setUpdateUi(msg, pctDl, serverMeta.version, {
              stage: 'downloading',
              transferredBytes: Math.max(0, downloaded),
              totalBytes: dlTotal,
              deltaFullBytes: serverMeta.size,
            });
          };
          // PR-3: сперва тянем изменившиеся блоки у LAN-пира (локально, не по WAN); при любом
          // сбое — фолбэк на server-delta. Оба пути — один примитив с integrity-гардом.
          const rangePeer = await pickDeltaRangePeer(apiBaseUrl, serverMeta.version);
          let deltaFirst: { ok: true; filePath: string } | { ok: false; error: string } = rangePeer
            ? await tryServerDeltaDownload(serverMeta, apiBaseUrl, { onProgress: onDeltaProgress, rangeBaseUrl: rangePeer })
            : { ok: false as const, error: 'no lan peer' };
          if (!deltaFirst.ok) {
            deltaFirst = await tryServerDeltaDownload(serverMeta, apiBaseUrl, { onProgress: onDeltaProgress });
          }
          if (deltaFirst.ok) {
            const cachedPath = await cacheInstaller(deltaFirst.filePath, serverMeta.version);
            const queued = await queuePendingUpdate({
              version: serverMeta.version,
              installerPath: cachedPath,
              expectedName: serverMeta.fileName,
              expectedSize: serverMeta.size,
              expectedSha: serverMeta.sha256 ?? null,
              downloadUrl: `delta://${serverMeta.fileName}`,
            });
            if (queued.ok) {
              await cacheDeltaFuel(serverMeta);
              void tryAdvertiseLan(serverMeta).catch(() => {});
              await releaseUpdateLock();
              lockReleased = true;
              backgroundInFlight = false;
              showUpdateWindow(null);
              await installNow({ installerPath: cachedPath, version: serverMeta.version });
              return;
            }
          }
        }
      }

      // 1) Торрент-пиры локальные (из /updates/peers)
      if (torrentMeta) {
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
            expectedSha: torrentMeta.sha256 ?? null,
            downloadUrl: tLocal.downloadUrl,
          });
          if (queued.ok) {
            await cacheDeltaFuel(serverMeta);
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
          expectedSha: serverMeta.sha256 ?? null,
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
          await cacheDeltaFuel(serverMeta);
          void tryAdvertiseLan(serverMeta).catch(() => {});
          await releaseUpdateLock();
          lockReleased = true;
          backgroundInFlight = false;
          showUpdateWindow(null);
          await installNow({ installerPath: cachedPath, version: serverMeta.version });
          return;
        }
      }

      // 3) Yandex
      const y = await tryYandexDownload();
      if (y?.ok) {
        void tryAdvertiseLan(serverMeta).catch(() => {});
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
        void tryAdvertiseLan(serverMeta).catch(() => {});
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
      if (torrentMeta) {
        candidateReason = candidateReason ?? 'torrent peers failed';
        const tAny = await tryDownloadFromTorrentPeers(torrentMeta, { localOnly: false, includeServerWebSeed: true });
        if (tAny.ok) {
          const cachedPath = await cacheInstaller(tAny.filePath, torrentMeta.version);
          const queued = await queuePendingUpdate({
            version: torrentMeta.version,
            installerPath: cachedPath,
            expectedName: torrentMeta.fileName,
            expectedSize: torrentMeta.size,
            expectedSha: torrentMeta.sha256 ?? null,
            downloadUrl: tAny.downloadUrl,
          });
          if (queued.ok) {
            await cacheDeltaFuel(serverMeta);
            void tryAdvertiseLan(serverMeta).catch(() => {});
            await releaseUpdateLock();
            lockReleased = true;
            backgroundInFlight = false;
            showUpdateWindow(null);
            await installNow({ installerPath: cachedPath, version: torrentMeta.version });
            return;
          }
        }
      }

      // 6) Прямая загрузка с сервера.
      candidateReason = candidateReason ?? 'server download failed';
      setUpdateState({
        state: 'downloading',
        source: 'server',
        version: serverMeta.version,
        progress: 0,
        message: 'Скачиваем обновление с сервера…',
      });
      const direct = await downloadUpdateFromServer(serverMeta, {
        onProgress: (pct) => {
          setUpdateState({
            state: 'downloading',
            source: 'server',
            version: serverMeta.version,
            progress: Math.max(0, Math.min(100, pct)),
            message: 'Скачиваем обновление с сервера…',
          });
        },
      });
      if (direct.ok) {
        const cachedPath = await cacheInstaller(direct.filePath, serverMeta.version);
        const queued = await queuePendingUpdate({
          version: serverMeta.version,
          installerPath: cachedPath,
          expectedName: serverMeta.fileName,
          expectedSize: serverMeta.size,
          expectedSha: serverMeta.sha256 ?? null,
          downloadUrl: direct.downloadUrl,
        });
        if (queued.ok) {
          void tryAdvertiseLan(serverMeta).catch(() => {});
          await releaseUpdateLock();
          lockReleased = true;
          backgroundInFlight = false;
          showUpdateWindow(null);
          await installNow({ installerPath: cachedPath, version: serverMeta.version });
          return;
        }
        candidateReason = queued.error;
      }

      // 7) Если все источники исчерпаны, предлагаем ручное скачивание и продолжаем работу.
      if (candidateVersion && Date.now() - lastManualUpdatePromptAt >= MANUAL_UPDATE_PROMPT_COOLDOWN_MS) {
        lastManualUpdatePromptAt = Date.now();
        const yCfg = await getYandexConfig().catch(() => null);
        showUpdateWindow(null);
        await promptManualUpdateFallback({
          version: candidateVersion,
          ...(yCfg?.publicKey ? { yandexUrl: yCfg.publicKey } : {}),
          ...(candidateReason ? { reason: candidateReason } : {}),
        });
        setUpdateState({ state: 'idle' });
        return;
      }

      setUpdateState({ state: 'idle' });
    } catch (e) {
      setUpdateState({ state: 'error', message: String(e) });
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
  attemptNo = 1,
): Promise<UpdateFlowResult> {
  await syncConfiguredUpdateDirFromSettings();
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

    await stageUpdate('Проверяем обновления на сервере…', 2);
    const current = app.getVersion();
    const startupServerMeta = await fetchLatestUpdateMetaFromServer();
    const serverVersion = startupServerMeta?.version ?? null;

    let candidateVersion: string | undefined;
    let candidateReason: string | undefined;

    const local = await resolveLocalInstaller(current, serverVersion);
    if (local.action === 'install') {
      await installNow({ installerPath: local.installerPath, version: local.version });
      return { action: 'update_started' };
    }

    const publishedUpdate = await resolvePublishedServerUpdate(current, startupServerMeta);
    if (!publishedUpdate) {
      // Клиент на последней версии — проактивно засеять delta-топливо для следующего релиза
      // (fire-and-forget: sha 110МБ не должен задерживать запуск приложения).
      void ensureDeltaFuelForCurrent(startupServerMeta).catch(() => {});
      await stageUpdate('Обновлений нет. Запускаем приложение…', 100, undefined, { stage: 'uptodate' });
      closeUpdateWindowSoon(300);
      return { action: 'no_update' };
    }
    const { serverMeta, torrentMeta } = publishedUpdate;
    candidateVersion = serverMeta.version;

    // 0) Delta-first: при наличии топлива (кэш installer'а текущей версии + blockmap + sidecar)
    // качаем только изменившиеся блоки — единицы МБ вместо полного installer'а (~110 МиБ).
    // Зеркало background-поллера; foreground выполняется ПЕРВЫМ на старте (index.ts), поэтому
    // без этого шага delta в поле почти не срабатывает (полный каскад качает 110 МиБ и quit'ит).
    // Дешёвый гард по sidecar ДО LAN-discovery: на свежем клиенте без топлива не добавляем
    // сетевой вызов в каждый старт. tryServerDeltaDownload самодостаточно гардирован
    // (sha mismatch / diff>80% / integrity → молча {ok:false}) → проход в полный каскад без регресса.
    {
      const apiBaseUrl = await resolveUpdateApiBaseUrl().catch(() => '');
      const haveFuel = !!(await readCachedInstallerSidecar().catch(() => null));
      if (apiBaseUrl && haveFuel) {
        const onDeltaProgress = (_pctAssembly: number, downloaded: number, downloadTotal: number | null) => {
          const dlTotal = downloadTotal ?? null;
          const pctDl = dlTotal && dlTotal > 0 ? Math.max(0, Math.min(100, (downloaded / dlTotal) * 100)) : 0;
          const msg = 'Догружаем только изменения…';
          // Окно показывает дельту: размер/бар/скорость — по докачке изменений, не по полному installer'у.
          void setUpdateUi(msg, pctDl, serverMeta.version, {
            stage: 'downloading',
            transferredBytes: Math.max(0, downloaded),
            totalBytes: dlTotal,
            deltaFullBytes: serverMeta.size,
          });
        };
        // PR-3: сперва тянем изменившиеся блоки у LAN-пира (локально, не по WAN); при любом
        // сбое — фолбэк на server-delta. Оба пути — один примитив с integrity-гардом.
        const rangePeer = await pickDeltaRangePeer(apiBaseUrl, serverMeta.version);
        let deltaFirst: { ok: true; filePath: string } | { ok: false; error: string } = rangePeer
          ? await tryServerDeltaDownload(serverMeta, apiBaseUrl, { onProgress: onDeltaProgress, rangeBaseUrl: rangePeer })
          : { ok: false as const, error: 'no lan peer' };
        if (!deltaFirst.ok) {
          deltaFirst = await tryServerDeltaDownload(serverMeta, apiBaseUrl, { onProgress: onDeltaProgress });
        }
        if (deltaFirst.ok) {
          const cachedPath = await cacheInstaller(deltaFirst.filePath, serverMeta.version);
          const queued = await queuePendingUpdate({
            version: serverMeta.version,
            installerPath: cachedPath,
            expectedName: serverMeta.fileName,
            expectedSize: serverMeta.size,
            expectedSha: serverMeta.sha256 ?? null,
            downloadUrl: `delta://${serverMeta.fileName}`,
          });
          if (queued.ok) {
            await cacheDeltaFuel(serverMeta);
            void tryAdvertiseLan(serverMeta).catch(() => {});
            await installNow({ installerPath: cachedPath, version: serverMeta.version });
            return { action: 'update_started' };
          }
        }
      }
    }

    // 1) Сначала торрент-пиры локальные.
    if (torrentMeta) {
      candidateReason = 'torrent local peers failed';
      await stageUpdate('Проверяем торрент-пиры в локальной сети…', 15, torrentMeta.version);
      const tLocal = await tryDownloadFromTorrentPeers(torrentMeta, {
        localOnly: true,
        onProgress: (pct, transferred, total) => {
          const safePct = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
          void setUpdateUi('Скачиваем (торрент-пиры, локальные)…', Math.max(5, safePct), torrentMeta.version, {
            stage: 'downloading',
            transferredBytes: Math.max(0, transferred),
            totalBytes: total && total > 0 ? total : null,
          });
        },
      });
      if (tLocal.ok) {
        const cachedPath = await cacheInstaller(tLocal.filePath, torrentMeta.version);
        const queued = await queuePendingUpdate({
          version: torrentMeta.version,
          installerPath: cachedPath,
          expectedName: torrentMeta.fileName,
          expectedSize: torrentMeta.size,
          expectedSha: torrentMeta.sha256 ?? null,
          downloadUrl: tLocal.downloadUrl,
        });
        if (!queued.ok) {
          await setUpdateUi(`Ошибка целостности: ${queued.error}`, 100, torrentMeta.version, {
            stage: 'error',
            errorText: INTEGRITY_RECOVERY_HINT,
          });
          candidateReason = queued.error;
        } else {
          await cacheDeltaFuel(serverMeta);
          void tryAdvertiseLan(serverMeta).catch(() => {});
          await installNow({ installerPath: cachedPath, version: torrentMeta.version });
          return { action: 'update_started' };
        }
      }
    }

    // 2) Локальная LAN-раздача.
    candidateReason = candidateReason ?? 'lan peers failed';
    await stageUpdate('Проверяем обновления в локальной сети…', 20);
    await stageUpdate('Скачиваем (локальная сеть)…', 5, serverMeta.version, { stage: 'downloading' });
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
        void setUpdateUi('Скачиваем (Локальная сеть)…', Math.max(5, safePct), serverMeta.version, {
          stage: 'downloading',
          transferredBytes: Math.max(0, transferred),
          totalBytes: total && total > 0 ? total : null,
        });
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
        expectedSha: serverMeta.sha256 ?? null,
        downloadUrl: `lan://${serverMeta.fileName}`,
      });
      if (!queued.ok) {
        await setUpdateUi(`Ошибка целостности: ${queued.error}`, 100, serverMeta.version, {
          stage: 'error',
          errorText: INTEGRITY_RECOVERY_HINT,
        });
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
        await cacheDeltaFuel(serverMeta);
        void tryAdvertiseLan(serverMeta).catch(() => {});
        await installNow({ installerPath: cachedPath, version: serverMeta.version });
        return { action: 'update_started' };
      }
    }

    // 3) Яндекс-диск.
    await stageUpdate('Проверяем Яндекс.Диск…', 30);
    const y = await checkYandexForUpdates();
    if (y.ok && y.updateAvailable && y.version) {
      candidateVersion = candidateVersion ?? y.version;
      await stageUpdate('Найдена новая версия (Yandex). Скачиваем…', 35, y.version, { stage: 'downloading' });
      await cleanupUpdateCache(y.version ?? 'latest');
      const yPath = 'path' in y ? y.path : undefined;
      const ydl = await downloadYandexUpdate(
        {
          version: y.version,
          ...(yPath ? { path: yPath } : {}),
          ...(y.downloadUrl ? { downloadUrl: y.downloadUrl } : {}),
        },
        {
          onProgress: (pct, transferred, total) => {
            void setUpdateUi('Скачиваем (Yandex)…', pct, y.version, {
              stage: 'downloading',
              transferredBytes: Math.max(0, transferred),
              totalBytes: total && total > 0 ? total : null,
            });
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
          // Yandex artifact's own sha (independent build), not server's.
          // See F2 in docs/plans/refactor-updater-2026-05.md.
          expectedSha: y.expectedSha ?? null,
          downloadUrl: y.downloadUrl ?? null,
        });
        if (!queued.ok) {
          await setUpdateUi(`Ошибка целостности: ${queued.error}`, 100, y.version, {
            stage: 'error',
            errorText: INTEGRITY_RECOVERY_HINT,
          });
          candidateReason = queued.error;
        } else {
          void tryAdvertiseLan(serverMeta).catch(() => {});
          await installNow({ installerPath: cachedPath, version: y.version });
          return { action: 'update_started' };
        }
      }
    }

    // 4) GitHub.
    await stageUpdate('Проверяем обновления через GitHub…', 45);
    const gh = await checkGithubReleaseForUpdates();
    if (gh.ok && gh.updateAvailable && gh.downloadUrl && gh.version) {
      candidateVersion = candidateVersion ?? gh.version;
      await stageUpdate('Найдена новая версия (GitHub). Скачиваем…', 50, gh.version, { stage: 'downloading' });
      await cleanupUpdateCache(gh.version ?? 'latest');
      const gdl = await downloadGithubUpdate(gh.downloadUrl, gh.version, {
        onProgress: (pct, transferred, total) => {
          void setUpdateUi('Скачиваем (GitHub)…', pct, gh.version, {
            stage: 'downloading',
            transferredBytes: Math.max(0, transferred),
            totalBytes: total && total > 0 ? total : null,
          });
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
          expectedSha: serverMeta.version === gh.version ? (serverMeta.sha256 ?? null) : null,
          downloadUrl: gh.downloadUrl ?? null,
        });
        if (!queued.ok) {
          await setUpdateUi(`Ошибка целостности: ${queued.error}`, 100, gh.version, {
            stage: 'error',
            errorText: INTEGRITY_RECOVERY_HINT,
          });
          candidateReason = queued.error;
        } else {
          void tryAdvertiseLan(serverMeta).catch(() => {});
          await installNow({ installerPath: cachedPath, version: gh.version });
          return { action: 'update_started' };
        }
      }
    }

    // 5) Любые торрент-пиры + раздача с сервера (/updates/file/:name).
    if (torrentMeta) {
      candidateReason = candidateReason ?? 'torrent peers failed';
      await stageUpdate('Пробуем скачать через любые торрент-пиры и сервер…', 60, torrentMeta.version, { stage: 'downloading' });
      const tAny = await tryDownloadFromTorrentPeers(torrentMeta, {
        localOnly: false,
        includeServerWebSeed: true,
        onProgress: (pct, transferred, total) => {
          void setUpdateUi('Скачиваем (торрент-пиры/сервер)…', pct, torrentMeta.version, {
            stage: 'downloading',
            transferredBytes: Math.max(0, transferred),
            totalBytes: total && total > 0 ? total : null,
          });
        },
      });
      if (tAny.ok) {
        const cachedPath = await cacheInstaller(tAny.filePath, torrentMeta.version);
        const queued = await queuePendingUpdate({
          version: torrentMeta.version,
          installerPath: cachedPath,
          expectedName: torrentMeta.fileName,
          expectedSize: torrentMeta.size,
          expectedSha: torrentMeta.sha256 ?? null,
          downloadUrl: tAny.downloadUrl,
        });
        if (queued.ok) {
          await cacheDeltaFuel(serverMeta);
          void tryAdvertiseLan(serverMeta).catch(() => {});
          await installNow({ installerPath: cachedPath, version: torrentMeta.version });
          return { action: 'update_started' };
        }
        candidateReason = queued.error;
      }
    }

    // 6) Прямая загрузка с сервера.
    candidateReason = candidateReason ?? 'server download failed';
    await stageUpdate('Скачиваем обновление с сервера…', 75, serverMeta.version, { stage: 'downloading' });
    const direct = await downloadUpdateFromServer(serverMeta, {
      onProgress: (pct, transferred, total) => {
        const safePct = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
        void setUpdateUi('Скачиваем с сервера…', Math.max(5, safePct), serverMeta.version, {
          stage: 'downloading',
          transferredBytes: Math.max(0, transferred),
          totalBytes: total && total > 0 ? total : null,
        });
      },
    });
    if (direct.ok) {
      const cachedPath = await cacheInstaller(direct.filePath, serverMeta.version);
      const queued = await queuePendingUpdate({
        version: serverMeta.version,
        installerPath: cachedPath,
        expectedName: serverMeta.fileName,
        expectedSize: serverMeta.size,
        expectedSha: serverMeta.sha256 ?? null,
        downloadUrl: direct.downloadUrl,
      });
      if (!queued.ok) {
        await setUpdateUi(`Ошибка целостности: ${queued.error}`, 100, serverMeta.version, {
          stage: 'error',
          errorText: INTEGRITY_RECOVERY_HINT,
        });
        candidateReason = queued.error;
      } else {
        void tryAdvertiseLan(serverMeta).catch(() => {});
        await installNow({ installerPath: cachedPath, version: serverMeta.version });
        return { action: 'update_started' };
      }
    }

    // 7) Если все источники исчерпаны, предлагаем ручное скачивание и запускаем программу.
    if (candidateVersion) {
      if (attemptNo < 2) {
        await stageUpdate('Не удалось скачать обновление. Повторяем полный цикл ещё раз…', 0, candidateVersion);
        await writeUpdaterLog(`update flow retry requested attempt=${attemptNo + 1} version=${candidateVersion}`);
        if (lockAcquired) {
          await releaseUpdateLock();
          lockAcquired = false;
        }
        updateInFlight = false;
        return await runAutoUpdateFlow(opts, attemptNo + 1);
      }
      const yCfg = await getYandexConfig().catch(() => null);
      await promptManualUpdateFallback({
        version: candidateVersion,
        ...(yCfg?.publicKey ? { yandexUrl: yCfg.publicKey } : {}),
        ...(candidateReason ? { reason: candidateReason } : {}),
      });
      await stageUpdate('Автообновление не удалось. Запускаем приложение без обновления.', 100, candidateVersion, {
        stage: 'error',
        errorText: 'Не удалось скачать обновление ни из одного источника. Программа продолжит работу и повторит попытку позже.',
      });
      closeUpdateWindowSoon(500);
      return { action: 'no_update' };
    }

    await stageUpdate('Обновлений нет. Запускаем приложение…', 100);
    closeUpdateWindowSoon(700);
    return { action: 'no_update' };
  } catch (e) {
    const message = String(e);
    await setUpdateUi(`Ошибка обновления: ${message}`, 100, undefined, { stage: 'error', errorText: message });
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
    const serverMeta = await fetchLatestUpdateMetaFromServer();
    if (!serverMeta) return { ok: true, updateAvailable: false };
    const current = app.getVersion();
    const updateAvailable = compareSemver(serverMeta.version, current) > 0;
    if (!updateAvailable) void tryAdvertiseLan(serverMeta).catch(() => {});
    return {
      ok: true,
      updateAvailable,
      version: serverMeta.version,
      source: 'server',
      expectedSize: serverMeta.size,
    };
  } catch (e) {
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
      await setUpdateUi('Ожидаем закрытия программы…', 72, args.version, { stage: 'installing' });
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
    await setUpdateUi('Запускаем установку…', 80, args.version, { stage: 'installing' });
    await writeUpdaterLog(`update-helper launching installer (detached)`);
    // Try immediate launch first — when the parent already exited cleanly
    // (the common case) the installer file is unlocked instantly and the
    // old 1.4s warm-up was pure dead time. Fall back to backoff retries
    // only when the immediate attempt fails (e.g. Windows EBUSY because
    // antivirus is still scanning the just-downloaded .exe).
    const launchAttempts = [
      { delayMs: 0, label: 'helper-try-immediate' },
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
      await setUpdateUi('Не удалось запустить установщик (возможно файл занят). Возвращаемся в приложение…', 100, args.version, {
        stage: 'error',
        errorText: 'Не удалось запустить установщик (возможно, файл занят антивирусом). Программа повторит установку при следующем запуске.',
      });
      closeUpdateWindowSoon(4000);
      spawn(args.launchPath, [], { detached: true, stdio: 'ignore', windowsHide: true });
      setTimeout(() => app.quit(), 4200);
      return;
    }
    app.exit(0);
  } catch (e) {
    await writeUpdaterLog(`update-helper error: ${String(e)}`);
    await setUpdateUi(`Ошибка установки: ${String(e)}`, 100, args.version, { stage: 'error', errorText: String(e) });
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
      // SHA-256 reported by Yandex Disk API for THIS file. Yandex hosts an
      // independently uploaded build, so its sha256 differs from the prod
      // server / GitHub release sha (electron-builder is not byte-deterministic).
      // Use this — not server's — when validating an installer downloaded
      // from Yandex.
      expectedSha?: string | null;
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

async function listPublicFolder(
  publicKey: string,
  pathOnDisk: string,
): Promise<Array<{ name: string; size: number | null; sha256: string | null }>> {
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
  const json = await r.json().catch(() => null);
  return extractYandexFolderItems(json).map(({ name, meta }) => ({
    name,
    size: meta.size,
    sha256: meta.sha256,
  }));
}

function extractVersionFromFileName(fileName: string): string | null {
  const m = fileName.match(/(\d+\.\d+\.\d+)/);
  return m?.[1] ?? null;
}

function getStableInstallerPath() {
  return join(getUpdatesRootDir(), FIXED_UPDATE_INSTALLER_NAME);
}

// Исход последнего обновления (method/bytes) — в userData, НЕ в updates-каталоге, чтобы
// cleanupUpdateCache (стирает посторонние файлы корня updates) его не зацепил. Пишется в
// installNow перед рестартом, отгружается reportPendingUpdateTelemetry при следующем старте.
function getUpdateOutcomePath() {
  return join(app.getPath('userData'), 'update-outcome.json');
}

async function prepareStableInstallerDownloadTarget() {
  const outDir = getUpdatesRootDir();
  await mkdir(outDir, { recursive: true });
  const outPath = getStableInstallerPath();
  await rm(outPath, { force: true });
  const alreadyExists = await stat(outPath).catch(() => null);
  if (alreadyExists?.isFile()) {
    throw new Error(`failed to replace existing installer: ${outPath}`);
  }
  return outPath;
}

async function tryAdvertiseLan(meta: ServerUpdateMeta): Promise<void> {
  if (!isLanUpdateEnabled()) return;
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
  const accessToken = await getUpdateAccessToken();
  const registered = await registerLanPeers(apiBaseUrl, meta.version, peers, accessToken);
  if (!registered.ok) {
    await logLan(`advertise registry failed: ${registered.error}`);
    return;
  }
  const latestTorrent = await fetchLatestTorrentFromServer();
  if (latestTorrent.ok && latestTorrent.infoHash && latestTorrent.version === meta.version) {
    const tReg = await registerUpdatePeers(apiBaseUrl, latestTorrent.infoHash, peers, accessToken);
    if (!tReg.ok) await logTorrent(`advertise peer registry failed: ${tReg.error}`);
  }
  await logLan(`advertise ok: port=${server.port} peers=${peers.length}`);
}

async function tryDownloadFromLan(
  meta: ServerUpdateMeta,
  opts?: { onProgress?: (pct: number, transferred: number, total: number | null) => void },
): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> {
  if (!isLanUpdateEnabled()) return { ok: false as const, error: 'lan update disabled' };
  const apiBaseUrl = await resolveUpdateApiBaseUrl();
  if (!apiBaseUrl) return { ok: false as const, error: 'apiBaseUrl missing' };
  const serverPort = getLanServerPort() ?? undefined;
  const selfPeers = getLocalLanPeers(serverPort ?? 0);
  const excludeIp = selfPeers[0]?.ip;
  const peers = await listLanPeers(apiBaseUrl, meta.version, excludeIp ? { ip: excludeIp, ...(serverPort != null ? { port: serverPort } : {}) } : undefined, await getUpdateAccessToken());
  await logLan(`download peers=${peers.length} version=${meta.version}`);
  if (!peers.length) return { ok: false as const, error: 'no peers' };

  const outPath = await prepareStableInstallerDownloadTarget();

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

// ── Blockmap-delta (ADR-0001 Этап-2, Путь B) ─────────────────────────────────
// Байты, реально докачанные последней успешной delta-сборкой — для телеметрии исхода
// (читается в installNow, сбрасывается там же). null = последнее обновление было не delta.
let lastDeltaDownloadedBytes: number | null = null;

// Sidecar кэшированного installer'а: какой версии exe лежит в getStableInstallerPath()
// и его sha256. Рядом кэшируется его .blockmap. Пишется после успешной server-закачки.
function getCachedInstallerSidecarPath() {
  return `${getStableInstallerPath()}.cache.json`;
}

function getCachedBlockmapPath() {
  return `${getStableInstallerPath()}.blockmap`;
}

async function readCachedInstallerSidecar(): Promise<{ version: string; sha256: string } | null> {
  try {
    const raw = await readFile(getCachedInstallerSidecarPath(), 'utf8');
    const json = JSON.parse(raw) as any;
    const version = String(json?.version ?? '').trim();
    const sha256 = String(json?.sha256 ?? '').trim();
    return version && sha256 ? { version, sha256 } : null;
  } catch {
    return null;
  }
}

async function fetchServerBlockmap(apiBaseUrl: string, blockmapFileName: string): Promise<Buffer | null> {
  try {
    const url = joinUrl(apiBaseUrl, `/updates/file/${encodeURIComponent(blockmapFileName)}`);
    const res = await fetchWithRetry(
      url,
      { method: 'GET' },
      { attempts: 3, timeoutMs: 15000, backoffMs: 600, maxBackoffMs: 3000, jitterMs: 200, retryOnStatuses: [502, 503, 504] },
    );
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// После успешной server-закачки сохраняем blockmap новой версии + sidecar — топливо
// для delta при СЛЕДУЮЩЕМ обновлении. Любой сбой не критичен (delta просто не включится).
// Source-agnostic: если кэшированный exe — не серверная сборка (зеркала Yandex/GitHub
// раздают независимо собранный installer с другим sha — F2) или серверный blockmap
// недоступен, генерим blockmap ЛОКАЛЬНО из фактических байтов кэша. Checksums тогда
// описывают реальный локальный файл → copy-блоки корректны независимо от происхождения
// exe; итоговая сборка всё равно верифицируется по meta.sha256 в tryServerDeltaDownload.
async function cacheServerDeltaArtifacts(meta: ServerUpdateMeta, apiBaseUrl: string): Promise<void> {
  try {
    const stablePath = getStableInstallerPath();
    const stableSha = await computeSha256(stablePath).catch(() => null);
    if (!stableSha) {
      await logLan('delta fuel skipped: no cached installer to seed from');
      return;
    }
    if (meta.blockmapFileName && meta.sha256 && stableSha === meta.sha256) {
      const blockmap = await fetchServerBlockmap(apiBaseUrl, meta.blockmapFileName);
      if (blockmap) {
        await writeFile(getCachedBlockmapPath(), blockmap);
        await writeFile(getCachedInstallerSidecarPath(), JSON.stringify({ version: meta.version, sha256: meta.sha256 }));
        await logLan(`delta artifacts cached version=${meta.version} blockmap=${blockmap.length}b`);
        return;
      }
      await logLan(`delta fuel: server blockmap ${meta.blockmapFileName} fetch failed — generating locally`);
    }
    const { generateBlockmap, serializeBlockmap } = await import('./blockmapDelta.js');
    const blockmap = serializeBlockmap(generateBlockmap(await readFile(stablePath)));
    await writeFile(getCachedBlockmapPath(), blockmap);
    await writeFile(getCachedInstallerSidecarPath(), JSON.stringify({ version: meta.version, sha256: stableSha }));
    await logLan(
      `delta artifacts generated locally version=${meta.version} blockmap=${blockmap.length}b (source-agnostic seed)`,
    );
  } catch (e) {
    await logLan(`delta artifacts cache failed: ${String(e)}`);
  }
}

// Топливо для delta при СЛЕДУЮЩЕМ обновлении: blockmap+sidecar кэшированного installer'а.
// Сервер-нога делает это сама внутри downloadUpdateFromServer; этот wrapper зовут LAN/torrent-
// ноги (они тоже скачивают канонический серверный файл) после cacheInstaller, до installNow.
async function cacheDeltaFuel(meta: ServerUpdateMeta): Promise<void> {
  const apiBaseUrl = await resolveUpdateApiBaseUrl().catch(() => '');
  if (!apiBaseUrl) return;
  await cacheServerDeltaArtifacts(meta, apiBaseUrl);
}

// Засев топлива при старте: если топлива нет, но клиент уже на последней версии
// (serverMeta.version === текущая) и stable-installer лежит в кэше — дотягиваем/генерим
// blockmap текущей версии + пишем sidecar (source-agnostic: при sha-расхождении с
// серверной сборкой blockmap генерится из локальных байтов, см. cacheServerDeltaArtifacts).
// Делает delta доступной для СЛЕДУЮЩЕГО релиза,
// не дожидаясь «двух обновлений». Это главный фикс рекуррентного «дельта не включается»:
// раньше топливо писалось только в момент скачивания и систематически терялось/не писалось
// (сервер без .blockmap до 620; mirror-источник; cleanup на fallback-ветках) → haveFuel=false
// на каждом старте. Здесь восстанавливаем актуальное топливо проактивно. Идемпотентно: при
// наличии sidecar — мгновенный выход; вызывать fire-and-forget (sha 110МБ не блокирует старт).
async function ensureDeltaFuelForCurrent(serverMeta: ServerUpdateMeta | null): Promise<void> {
  try {
    if (await readCachedInstallerSidecar().catch(() => null)) return; // топливо уже есть
    if (!serverMeta?.version) return;
    if (serverMeta.version !== app.getVersion()) return; // сервер отдаёт latest; сеять можно лишь когда latest == текущая
    const apiBaseUrl = await resolveUpdateApiBaseUrl().catch(() => '');
    if (!apiBaseUrl) return;
    await logLan(`delta fuel seed: no fuel + client on latest (${serverMeta.version}) — seeding from cached installer`);
    await cacheServerDeltaArtifacts(serverMeta, apiBaseUrl);
  } catch (e) {
    await logLan(`delta fuel seed failed: ${String(e)}`);
  }
}

// Снимок исхода обновления (delta vs full + байты) перед рестартом. installNow квитит
// приложение, поэтому шлём не сейчас, а при следующем старте (reportPendingUpdateTelemetry),
// когда уже работает новая версия. method выводим из схемы downloadUrl: delta:// = дельта,
// всё остальное (lan/torrent/server/yandex/github) — полная передача файла.
async function recordUpdateOutcome(args: {
  toVersion: string | null;
  downloadUrl: string | null;
  fullBytes: number | null;
}): Promise<void> {
  try {
    const isDelta = typeof args.downloadUrl === 'string' && args.downloadUrl.startsWith('delta://');
    const downloadedBytes = isDelta ? lastDeltaDownloadedBytes : args.fullBytes;
    const outcome = {
      fromVersion: app.getVersion(),
      toVersion: args.toVersion,
      method: isDelta ? 'delta' : 'full',
      downloadedBytes: downloadedBytes ?? null,
      fullBytes: args.fullBytes ?? null,
      at: Date.now(),
    };
    await writeFile(getUpdateOutcomePath(), JSON.stringify(outcome), 'utf8');
  } catch {
    // телеметрия исхода некритична
  } finally {
    lastDeltaDownloadedBytes = null;
  }
}

// Отгрузка исхода последнего обновления ОДИН раз после рестарта. Канал — существующий
// client-log pipeline (/logs/client): строка садится в дневной серверный лог = постоянное
// видимое поле method+bytes (переиспользуем diagnostics-инфраструктуру, без нового endpoint'а).
// Уровень 'warn' гарантирует доставку в prod-режиме; critical:false → не засоряет панель
// критических событий (полную закачку как warn-событие классифицирует серверный CLIENT_PATTERN
// 'update-applied method=full' отдельно — свежие установки телеметрию не шлют, поэтому это
// чистый сигнал «у существующего клиента дельта не сработала»).
export async function reportPendingUpdateTelemetry(db: BetterSQLite3Database, apiBaseUrl: string): Promise<void> {
  const path = getUpdateOutcomePath();
  let outcome: Record<string, unknown> | null = null;
  try {
    outcome = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return; // нет файла исхода — нечего слать
  }
  await rm(path, { force: true }).catch(() => {});
  try {
    const toVersion = String(outcome?.toVersion ?? '').trim();
    // Шлём только если обновление реально применилось (работает целевая версия).
    if (!toVersion || toVersion !== app.getVersion()) return;
    const method = outcome?.method === 'delta' ? 'delta' : 'full';
    const dlRaw = Number(outcome?.downloadedBytes);
    const fullRaw = Number(outcome?.fullBytes);
    const dl = Number.isFinite(dlRaw) && dlRaw >= 0 ? dlRaw : null;
    const full = Number.isFinite(fullRaw) && fullRaw > 0 ? fullRaw : null;
    const pct = dl != null && full != null ? Math.round((dl / full) * 100) : null;
    const fromVersion = String(outcome?.fromVersion ?? '');
    const message =
      `update-applied method=${method} from=${fromVersion || '?'} to=${toVersion} ` +
      `downloaded=${dl ?? '?'} full=${full ?? '?'}${pct != null ? ` (${pct}%)` : ''}`;
    const { logMessage } = await import('./logService.js');
    await logMessage(db, apiBaseUrl, 'warn', message, {
      component: 'updater',
      event: 'update-applied',
      method,
      ...(dl != null ? { downloadedBytes: dl } : {}),
      ...(full != null ? { fullBytes: full } : {}),
      ...(fromVersion ? { fromVersion } : {}),
      toVersion,
    });
  } catch {
    // некритично
  }
}

// PR-3: ищем LAN-пир, раздающий целевую версию (он отдаёт /updates/file с Range 206),
// чтобы тянуть изменившиеся блоки delta у соседа, а не по WAN. Зеркалит discovery из
// tryDownloadFromLan. Возвращает base-URL пира (http://ip:port) или null.
async function pickDeltaRangePeer(apiBaseUrl: string, version: string): Promise<string | null> {
  if (!isLanUpdateEnabled()) return null;
  const serverPort = getLanServerPort() ?? undefined;
  const selfPeers = getLocalLanPeers(serverPort ?? 0);
  const excludeIp = selfPeers[0]?.ip;
  const peers = await listLanPeers(
    apiBaseUrl,
    version,
    excludeIp ? { ip: excludeIp, ...(serverPort != null ? { port: serverPort } : {}) } : undefined,
    await getUpdateAccessToken(),
  ).catch(() => [] as Array<{ ip: string; port?: number }>);
  for (const peer of peers) {
    const ip = String(peer.ip ?? '').trim();
    const port = Number(peer.port ?? 0);
    if (ip && Number.isFinite(port) && port > 0) return `http://${ip}:${port}`;
  }
  return null;
}

// blockmap + meta всегда с сервера (LAN-пир раздаёт только сам .exe, не .blockmap); а вот
// крупные Range-диапазоны можно тянуть у LAN-пира (opts.rangeBaseUrl) ради локальности —
// фолбэк на сервер делает вызывающий (delta-first), повторяя вызов с rangeBaseUrl=apiBaseUrl.
async function tryServerDeltaDownload(
  meta: ServerUpdateMeta,
  apiBaseUrl: string,
  opts?: { onProgress?: (pct: number, transferred: number, total: number | null) => void; rangeBaseUrl?: string },
): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> {
  if (!meta.blockmapFileName) return { ok: false as const, error: 'no blockmap on server' };
  const sidecar = await readCachedInstallerSidecar();
  if (!sidecar) return { ok: false as const, error: 'no cached installer sidecar' };
  if (sidecar.version === meta.version) return { ok: false as const, error: 'cached installer is already target version' };
  const oldExePath = getStableInstallerPath();
  const oldExeStat = await stat(oldExePath).catch(() => null);
  const oldBlockmapBuf = await readFile(getCachedBlockmapPath()).catch(() => null);
  if (!oldExeStat?.isFile() || !oldBlockmapBuf) return { ok: false as const, error: 'no cached installer/blockmap' };
  const oldSha = await computeSha256(oldExePath);
  if (oldSha !== sidecar.sha256) return { ok: false as const, error: 'cached installer sha mismatch' };

  const newBlockmapBuf = await fetchServerBlockmap(apiBaseUrl, meta.blockmapFileName);
  if (!newBlockmapBuf) return { ok: false as const, error: 'new blockmap download failed' };

  const { parseBlockmap, computeDeltaPlan, assembleFromPlan, summarizeDeltaPlan, formatDeltaReport } =
    await import('./blockmapDelta.js');
  let plan: DeltaPlan;
  try {
    plan = computeDeltaPlan(parseBlockmap(oldBlockmapBuf), parseBlockmap(newBlockmapBuf));
  } catch (e) {
    return { ok: false as const, error: `blockmap parse/diff failed: ${String(e)}` };
  }
  if (plan.totalSize !== meta.size) {
    return { ok: false as const, error: `blockmap total ${plan.totalSize} != meta size ${meta.size}` };
  }
  const report = summarizeDeltaPlan(plan);
  if (!report.worthIt) {
    return { ok: false as const, error: `delta not worth it: ${plan.downloadSize}/${plan.totalSize}` };
  }
  const rangeBase = opts?.rangeBaseUrl?.trim() || apiBaseUrl;
  const rangeSrc = rangeBase === apiBaseUrl ? 'server' : 'lan-peer';
  await logLan(`delta plan: ${formatDeltaReport(report)} source=${rangeSrc}`);

  const fileUrl = joinUrl(rangeBase, `/updates/file/${encodeURIComponent(meta.fileName)}`);
  const downloadRange = async (start: number, endInclusive: number): Promise<Buffer> => {
    const res = await fetchWithRetry(
      fileUrl,
      { method: 'GET', headers: { Range: `bytes=${start}-${endInclusive}` } },
      { attempts: 3, timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS, backoffMs: 800, maxBackoffMs: 6000, jitterMs: 300, retryOnStatuses: [502, 503, 504] },
    );
    if (res.status !== 206) throw new Error(`range not supported: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  // Собираем во временный файл: stable path занят старым exe — источником copy-блоков.
  // Имя ДОЛЖНО оканчиваться на .exe — validateInstallerPath отвергает не-.exe (раньше
  // имя `<installer>.delta.tmp` валило integrity → молчаливый откат на полную закачку,
  // т.е. delta не срабатывала никогда; см. installerNaming.ts).
  const tmpPath = deltaAssemblyTempPath(oldExePath);
  await rm(tmpPath, { force: true }).catch(() => {});
  try {
    let downloaded = 0;
    await assembleFromPlan({
      plan,
      oldFilePath: oldExePath,
      outFilePath: tmpPath,
      downloadRange: async (start, end) => {
        const buf = await downloadRange(start, end);
        downloaded += buf.length;
        return buf;
      },
      onProgress: (written, total) => {
        const pct = total > 0 ? (written / total) * 100 : 0;
        opts?.onProgress?.(pct, downloaded, plan.downloadSize);
      },
    });
    const integrity = await validateInstallerIntegrity(tmpPath, meta.fileName, meta.size, meta.sha256);
    if (!integrity.ok) throw new Error(`assembled installer integrity: ${integrity.error}`);
    const outPath = await prepareStableInstallerDownloadTarget();
    await copyFile(tmpPath, outPath);
    await rm(tmpPath, { force: true }).catch(() => {});
    await logLan(`delta ok: ${formatDeltaReport(report)} (downloaded ${downloaded}b instead of ${meta.size}b)`);
    lastDeltaDownloadedBytes = downloaded;
    return { ok: true as const, filePath: outPath };
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => {});
    // Раньше эта ветка молчала → системный сбой delta (имя temp-файла) был невидим в логе.
    await logLan(`delta assembly failed after plan (falling back to full): ${String(e)}`);
    return { ok: false as const, error: String(e) };
  }
}

async function downloadUpdateFromServer(
  meta: ServerUpdateMeta,
  opts?: { onProgress?: (pct: number, transferred: number, total: number | null) => void },
): Promise<{ ok: true; filePath: string; downloadUrl: string } | { ok: false; error: string }> {
  const apiBaseUrl = await resolveUpdateApiBaseUrl();
  if (!apiBaseUrl) return { ok: false as const, error: 'apiBaseUrl missing' };

  const downloadUrl = joinUrl(apiBaseUrl, `/updates/file/${encodeURIComponent(meta.fileName)}`);

  // Сначала пробуем blockmap-delta (качаем только изменившиеся блоки); любой сбой —
  // молчаливый откат на полную закачку, существующий путь не трогаем.
  const delta = await tryServerDeltaDownload(meta, apiBaseUrl, opts ?? {});
  if (delta.ok) {
    await cacheServerDeltaArtifacts(meta, apiBaseUrl);
    return { ok: true as const, filePath: delta.filePath, downloadUrl };
  }
  await logLan(`delta unavailable (${delta.error}), falling back to full download`);

  const outPath = await prepareStableInstallerDownloadTarget();
  const dl = await downloadWithResume(downloadUrl, outPath, {
    attempts: 3,
    timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
    noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
    useBitsOnWindows: false,
    backoffMs: 800,
    maxBackoffMs: 6000,
    jitterMs: 300,
    ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  if (!dl.ok || !dl.filePath) return { ok: false as const, error: dl.error ?? 'server download failed' };

  const integrity = await validateInstallerIntegrity(outPath, meta.fileName, meta.size, meta.sha256);
  if (!integrity.ok) {
    await rm(outPath, { force: true }).catch(() => {});
    return { ok: false as const, error: integrity.error };
  }
  await cacheServerDeltaArtifacts(meta, apiBaseUrl);
  return { ok: true as const, filePath: outPath, downloadUrl };
}

function pickNewestInstaller<T extends { name: string }>(items: T[]): T | null {
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

async function getYandexItemMeta(
  publicKey: string,
  pathOnDisk: string,
): Promise<{ size: number | null; sha256: string | null } | null> {
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
  const json = (await r.json().catch(() => null));
  const meta = extractYandexResourceMeta(json);
  return { size: meta.size, sha256: meta.sha256 };
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
            expectedSha: meta?.sha256 ?? null,
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
      expectedSha: exe.sha256 ?? null,
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
    const outPath = await prepareStableInstallerDownloadTarget();
    return await downloadWithResume(href, outPath, {
      attempts: 4,
      timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
      noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
      useBitsOnWindows: false,
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
  _version?: string,
  opts?: { onProgress?: (pct: number, transferred: number, total: number | null) => void },
) {
  try {
    const outPath = await prepareStableInstallerDownloadTarget();
    return await downloadWithResume(url, outPath, {
      attempts: 4,
      timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
      noProgressTimeoutMs: UPDATE_DOWNLOAD_NO_PROGRESS_MS,
      useBitsOnWindows: false,
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

async function spawnInstallerDetached(installerPath: string, delayMs = 0): Promise<boolean> {
  await describePath('installer-detached', installerPath);
  // The caller picks the leading delay — `delayMs: 0` for the optimistic
  // first attempt. Backoffs after that protect against EBUSY from
  // antivirus / locked-file races.
  const attempts = [
    { delayMs: Math.max(0, delayMs), label: 'initial' },
    { delayMs: 2000, label: 'retry-1' },
    { delayMs: 5000, label: 'retry-2' },
    { delayMs: 10_000, label: 'retry-3' },
  ];

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    if (!attempt) continue;
    await writeUpdaterLog(`installer launch scheduled in ${Math.round(attempt.delayMs / 1000)}s (${attempt.label})`);
    await sleep(attempt.delayMs);
    try {
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


