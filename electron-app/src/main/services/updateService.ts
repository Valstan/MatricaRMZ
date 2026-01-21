import { app, BrowserWindow, net } from 'electron';
import updater from 'electron-updater';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import {
  buildTorrentManifestUrl,
  downloadTorrentUpdate,
  fetchTorrentManifest,
  fetchTorrentStatus,
  saveTorrentFileForVersion,
  saveTorrentSeedInfo,
  type TorrentUpdateManifest,
} from './torrentUpdateService.js';

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string; source?: 'torrent' | 'github' | 'yandex'; downloadUrl?: string }
  | { ok: false; error: string };

export type UpdateFlowResult =
  | { action: 'no_update' }
  | { action: 'update_started' }
  | { action: 'error'; error: string };

export type UpdateHelperArgs = {
  installerPath: string;
  launchPath: string;
  version?: string;
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

async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = UPDATE_CHECK_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
  const outDir = join(app.getPath('userData'), 'updates', ver);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, basename(filePath));
  if (outPath === filePath) return outPath;
  await copyFile(filePath, outPath).catch(() => {});
  return outPath;
}

function pendingUpdatePath() {
  return join(app.getPath('userData'), 'updates', 'pending-update.json');
}

async function writePendingUpdate(data: { version: string; installerPath: string }) {
  const outDir = join(app.getPath('userData'), 'updates');
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

export async function applyPendingUpdateIfAny(parentWindow?: BrowserWindow | null): Promise<boolean> {
  const pending = await readPendingUpdate();
  if (!pending?.installerPath) return false;
  try {
    await access(pending.installerPath);
  } catch {
    await clearPendingUpdate();
    return false;
  }
  showUpdateWindow(parentWindow ?? null);
  lockUpdateUi(true);
  await setUpdateUi('Найдена скачанная версия. Устанавливаем…', 80, pending.version);
  const helper = await prepareUpdateHelper();
  spawnUpdateHelper({
    helperExePath: helper.helperExePath,
    installerPath: pending.installerPath,
    launchPath: helper.launchPath,
    resourcesPath: helper.resourcesPath,
    version: pending.version,
  });
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
  await writePendingUpdate({ version, installerPath: cachedPath });
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
    try {
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
    }
  }
}

export async function runAutoUpdateFlow(
  opts: { reason: 'startup' | 'manual_menu'; parentWindow?: BrowserWindow | null } = { reason: 'startup' },
): Promise<UpdateFlowResult> {
  if (updateInFlight) return { action: 'error', error: 'update already in progress' };
  updateInFlight = true;
  try {
    showUpdateWindow(opts.parentWindow ?? null);
    await stageUpdate('Проверяем обновления…', 0);

    if (!app.isPackaged) {
      closeUpdateWindowSoon(300);
      return { action: 'no_update' };
    }

    await stageUpdate('Проверяем торрент-обновления…', 2);
    const torrentCheck = await checkTorrentForUpdates();
    let torrentManifest: TorrentUpdateManifest | null = null;
    if (torrentCheck.ok && torrentCheck.updateAvailable && torrentCheck.manifest) {
      torrentManifest = torrentCheck.manifest;
      await stageUpdate(`Найдена новая версия (Torrent). Подключаемся…`, 5, torrentCheck.version);
      const tdl = await downloadTorrentUpdate(torrentManifest, {
        onProgress: (pct, peers) => {
          void setUpdateUi(`Скачиваем (Torrent)… Пиры: ${peers}`, pct, torrentCheck.version);
        },
      });
      if (tdl.ok) {
        const cachedPath = await cacheInstaller(tdl.installerPath, torrentCheck.version);
        lastDownloadedInstallerPath = cachedPath;
        await saveTorrentSeedInfo({ version: torrentManifest.version, installerPath: cachedPath, torrentPath: tdl.torrentPath });
        await stageUpdate('Скачивание завершено. Готовим установку…', 60, torrentCheck.version);
        lockUpdateUi(true);
        await stageUpdate('Подготовка установщика…', 70, torrentCheck.version);
        const helper = await prepareUpdateHelper();
        spawnUpdateHelper({
          helperExePath: helper.helperExePath,
          installerPath: cachedPath,
          launchPath: helper.launchPath,
          resourcesPath: helper.resourcesPath,
          version: torrentCheck.version,
        });
        await stageUpdate('Запускаем установку…', 80, torrentCheck.version);
        quitMainAppSoon();
        return { action: 'update_started' };
      }
      await stageUpdate(`Торрент недоступен, пробуем GitHub…`, 15, torrentCheck.version);
    } else if (!torrentCheck.ok) {
      await stageUpdate(`Торрент недоступен (${torrentCheck.error}). Пробуем GitHub…`, 15);
    } else {
      await stageUpdate('Торрент обновлений не найден. Пробуем GitHub…', 15);
    }

    await stageUpdate('Проверяем обновления через GitHub…', 20);
    const check = await waitForUpdateCheck();
    if (check.ok && check.updateAvailable) {
      await stageUpdate(`Найдена новая версия (GitHub). Скачиваем…`, 5, check.version);
      const download = await downloadUpdate(check.version);
      if (!download.ok || !download.filePath) {
        await setUpdateUi(`Ошибка скачивания: ${download.error ?? 'unknown'}`, 100, check.version);
        closeUpdateWindowSoon(3500);
        return { action: 'error', error: download.error ?? 'download failed' };
      }
      const cachedPath = await cacheInstaller(download.filePath, check.version);
      lastDownloadedInstallerPath = cachedPath;
      await ensureTorrentSeedArtifacts(torrentManifest, cachedPath, check.version);
      await stageUpdate('Скачивание завершено. Готовим установку…', 60, check.version);
      lockUpdateUi(true);
      await stageUpdate('Подготовка установщика…', 70, check.version);
      const helper = await prepareUpdateHelper();
      spawnUpdateHelper({
        helperExePath: helper.helperExePath,
        installerPath: cachedPath,
        launchPath: helper.launchPath,
        resourcesPath: helper.resourcesPath,
        version: check.version,
      });
      await stageUpdate('Запускаем установку…', 80, check.version);
      quitMainAppSoon();
      return { action: 'update_started' };
    }

    const gh = await checkGithubReleaseForUpdates();
    if (gh.ok && gh.updateAvailable && gh.downloadUrl) {
      await stageUpdate(`Найдена новая версия (GitHub). Скачиваем…`, 5, gh.version);
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
      await stageUpdate('Скачивание завершено. Готовим установку…', 60, gh.version);
      lockUpdateUi(true);
      await stageUpdate('Подготовка установщика…', 70, gh.version);
      const helper = await prepareUpdateHelper();
      spawnUpdateHelper({
        helperExePath: helper.helperExePath,
        installerPath: cachedPath,
        launchPath: helper.launchPath,
        resourcesPath: helper.resourcesPath,
        version: gh.version,
      });
      await stageUpdate('Запускаем установку…', 80, gh.version);
      quitMainAppSoon();
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
    await stageUpdate('Скачивание завершено. Готовим установку…', 60, fallback.version);
    lockUpdateUi(true);
    await stageUpdate('Подготовка установщика…', 70, fallback.version);
    const helper = await prepareUpdateHelper();
    spawnUpdateHelper({
      helperExePath: helper.helperExePath,
      installerPath: cachedPath,
      launchPath: helper.launchPath,
      resourcesPath: helper.resourcesPath,
      version: fallback.version,
    });
    await stageUpdate('Запускаем установку…', 80, fallback.version);
    quitMainAppSoon();
    return { action: 'update_started' };
  } catch (e) {
    const message = String(e);
    await setUpdateUi(`Ошибка обновления: ${message}`, 100);
    closeUpdateWindowSoon(3500);
    return { action: 'error', error: message };
  } finally {
    updateInFlight = false;
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
    await setUpdateUi('Подготовка установки…', 70, args.version);
    await sleep(800);
    await setUpdateUi('Удаляем старую версию…', 75, args.version);
    const exitCode = await runSilentInstaller(args.installerPath);
    if (exitCode !== 0) {
      await setUpdateUi(`Ошибка установки: code=${exitCode}`, 100, args.version);
      closeUpdateWindowSoon(4000);
      setTimeout(() => app.quit(), 4200);
      return;
    }
    await setUpdateUi('Установка завершена. Запускаем программу…', 95, args.version);
    spawn(args.launchPath, [], { detached: true, stdio: 'ignore', windowsHide: true });
    await sleep(800);
    app.quit();
  } catch (e) {
    await setUpdateUi(`Ошибка установки: ${String(e)}`, 100, args.version);
    closeUpdateWindowSoon(4000);
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
  const res = await fetchWithTimeout(url, { method: 'GET' });
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
  const r = await fetchWithTimeout(api);
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
  const parsed = exes
    .map((n) => ({ n, v: extractVersionFromFileName(n) }))
    .filter((x) => x.v);
  if (parsed.length === 0) return exes[0];
  parsed.sort((a, b) => compareSemver(b.v!, a.v!));
  return parsed[0].n;
}

async function downloadToFileWithProgress(
  res: Response,
  outPath: string,
  opts?: { onProgress?: (pct: number, transferred: number, total: number | null) => void },
) {
  if (!res.body) throw new Error('response has no body');
  const total = Number(res.headers.get('content-length') ?? 0) || null;
  let downloaded = 0;
  const stream = Readable.fromWeb(res.body as any);
  stream.on('data', (chunk) => {
    downloaded += chunk.length ?? 0;
    if (total && total > 0) {
      const pct = Math.max(0, Math.min(99, Math.floor((downloaded / total) * 100)));
      opts?.onProgress?.(pct, downloaded, total);
    } else {
      opts?.onProgress?.(0, downloaded, null);
    }
  });
  await pipeline(stream, createWriteStream(outPath));
  opts?.onProgress?.(100, downloaded, total ?? downloaded);
}

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
      const res = await fetchWithTimeout(href);
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
    const res = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'MatricaRMZ-Updater',
        },
      },
      10_000,
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
    const exe = assets.find((a: any) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('.exe'));
    const downloadUrl = exe?.browser_download_url ? String(exe.browser_download_url) : undefined;
    if (!downloadUrl) return { ok: false, error: 'github release missing exe asset' };
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
    const res = await fetchWithTimeout(href, { method: 'GET' }, UPDATE_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok || !res.body) return { ok: false as const, error: `yandex download HTTP ${res.status}` };
    const outDir = join(tmpdir(), 'MatricaRMZ-Updates');
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, fileName);
    await downloadToFileWithProgress(res, outPath, opts);
    return { ok: true as const, filePath: outPath };
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
    const res = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'MatricaRMZ-Updater',
        },
      },
      UPDATE_DOWNLOAD_TIMEOUT_MS,
    );
    if (!res.ok || !res.body) return { ok: false as const, error: `github download HTTP ${res.status}` };
    const fileName = basename(new URL(url).pathname) || `MatricaRMZ-${version ?? 'update'}.exe`;
    const outDir = join(tmpdir(), 'MatricaRMZ-Updates');
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, fileName);
    await downloadToFileWithProgress(res, outPath, opts);
    return { ok: true as const, filePath: outPath };
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
      resolve({ ok: true, updateAvailable: true, version: String(info?.version ?? '') || undefined, source: 'github' });
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

function spawnUpdateHelper(args: { helperExePath: string; installerPath: string; launchPath: string; resourcesPath: string; version?: string }) {
  const spawnArgs = ['--update-helper', '--installer', args.installerPath, '--launch', args.launchPath];
  if (args.version) spawnArgs.push('--version', args.version);
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
}

async function runSilentInstaller(installerPath: string): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(installerPath, ['/S'], { windowsHide: true, stdio: 'ignore' });
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
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


