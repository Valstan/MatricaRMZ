import { app, BrowserWindow, net } from 'electron';
import updater from 'electron-updater';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string; source?: 'github' | 'yandex' }
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

export function initAutoUpdate() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
}

let updateInFlight = false;
let updateUiWindow: BrowserWindow | null = null;
let updateUiLocked = false;

function showUpdateWindow(parent?: BrowserWindow | null) {
  if (updateUiWindow && !updateUiWindow.isDestroyed()) return updateUiWindow;
  updateUiWindow = new BrowserWindow({
    width: 420,
    height: 220,
    modal: !!parent,
    parent: parent ?? undefined,
    title: `Обновление MatricaRMZ`,
    resizable: false,
    minimizable: false,
    maximizable: false,
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
  </style></head>
  <body>
    <h2 style="margin:0">Обновление</h2>
    <div id="msg" class="muted" style="margin-top:8px">Проверяем обновления…</div>
    <div class="row"><div class="pct" id="pct">0%</div><div class="muted" id="ver"></div></div>
    <div class="bar"><div class="fill" id="fill"></div></div>
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

export async function runAutoUpdateFlow(
  opts: { reason: 'startup' | 'manual_menu'; parentWindow?: BrowserWindow | null } = { reason: 'startup' },
): Promise<UpdateFlowResult> {
  if (updateInFlight) return { action: 'error', error: 'update already in progress' };
  updateInFlight = true;
  try {
    showUpdateWindow(opts.parentWindow ?? null);
    await setUpdateUi('Проверяем обновления…', 0);

    if (!app.isPackaged) {
      closeUpdateWindowSoon(300);
      return { action: 'no_update' };
    }

    const check = await waitForUpdateCheck();
    if (!check.ok || !check.updateAvailable) {
      const fallback = await checkYandexForUpdates();
      if (!fallback.ok) {
        if (!check.ok) {
          await setUpdateUi(`Ошибка проверки: ${check.error}`, 0);
          closeUpdateWindowSoon(3500);
          return { action: 'error', error: check.error };
        }
        await setUpdateUi('Обновлений нет. Запускаем приложение…', 100);
        closeUpdateWindowSoon(700);
        return { action: 'no_update' };
      }
      if (!fallback.updateAvailable) {
        await setUpdateUi('Обновлений нет. Запускаем приложение…', 100);
        closeUpdateWindowSoon(700);
        return { action: 'no_update' };
      }
      await setUpdateUi(`Найдена новая версия. Скачиваем…`, 5, fallback.version);
      const ydl = await downloadYandexUpdate(fallback);
      if (!ydl.ok || !ydl.filePath) {
        await setUpdateUi(`Ошибка скачивания: ${ydl.error ?? 'unknown'}`, 100, fallback.version);
        closeUpdateWindowSoon(3500);
        return { action: 'error', error: ydl.error ?? 'download failed' };
      }
      lastDownloadedInstallerPath = ydl.filePath;
      await setUpdateUi('Скачивание завершено. Готовим установку…', 60, fallback.version);
      lockUpdateUi(true);
      await setUpdateUi('Подготовка установщика…', 70, fallback.version);
      const helper = await prepareUpdateHelper();
      spawnUpdateHelper({
        helperExePath: helper.helperExePath,
        installerPath: ydl.filePath,
        launchPath: helper.launchPath,
        resourcesPath: helper.resourcesPath,
        version: fallback.version,
      });
      await setUpdateUi('Запускаем установку…', 80, fallback.version);
      return { action: 'update_started' };
    }

    await setUpdateUi(`Найдена новая версия. Скачиваем…`, 5, check.version);
    const download = await downloadUpdate(check.version);
    if (!download.ok || !download.filePath) {
      await setUpdateUi(`Ошибка скачивания: ${download.error ?? 'unknown'}`, 100, check.version);
      closeUpdateWindowSoon(3500);
      return { action: 'error', error: download.error ?? 'download failed' };
    }
    lastDownloadedInstallerPath = download.filePath;
    await setUpdateUi('Скачивание завершено. Готовим установку…', 60, check.version);
    lockUpdateUi(true);
    await setUpdateUi('Подготовка установщика…', 70, check.version);
    const helper = await prepareUpdateHelper();
    spawnUpdateHelper({
      helperExePath: helper.helperExePath,
      installerPath: download.filePath,
      launchPath: helper.launchPath,
      resourcesPath: helper.resourcesPath,
      version: check.version,
    });
    await setUpdateUi('Запускаем установку…', 80, check.version);
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
    const result = await autoUpdater.checkForUpdates();
    const latest = String((result as any)?.updateInfo?.version ?? '');
    const current = app.getVersion();
    const updateAvailable = latest ? compareSemver(latest, current) > 0 : false;
    if (updateAvailable) return { ok: true, updateAvailable, version: latest || undefined, source: 'github' };
    const y = await checkYandexForUpdates();
    if (y.ok) return y;
    return { ok: true, updateAvailable: false };
  } catch (e) {
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

async function getYandexDownloadHref(publicKey: string, path: string): Promise<string | null> {
  const url =
    'https://cloud-api.yandex.net/v1/disk/public/resources/download?' +
    new URLSearchParams({ public_key: publicKey, path: normalizePublicPath(path) }).toString();
  const res = await net.fetch(url, { method: 'GET' });
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
  const r = await net.fetch(api);
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
      const res = await net.fetch(href);
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

async function downloadYandexUpdate(info: { version?: string; path?: string }) {
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
    const res = await net.fetch(href);
    if (!res.ok || !res.body) return { ok: false as const, error: `yandex download HTTP ${res.status}` };
    const outDir = join(tmpdir(), 'MatricaRMZ-Updates');
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, fileName);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(outPath));
    return { ok: true as const, filePath: outPath };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

async function waitForUpdateCheck(): Promise<UpdateCheckResult> {
  return await new Promise<UpdateCheckResult>((resolve) => {
    const cleanup = () => {
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
  const resourcesDir = join(appDir, 'resources');
  const baseTemp = join(app.getPath('temp'), 'MatricaRMZ-UpdateHelper');
  const stamp = String(Date.now());
  const helperDir = join(baseTemp, `helper-${stamp}`);
  await mkdir(helperDir, { recursive: true });
  const helperExePath = join(helperDir, 'MatricaRMZ-Updater.exe');
  const helperResources = join(helperDir, 'resources');
  await copyFile(launchPath, helperExePath);
  await cp(resourcesDir, helperResources, { recursive: true, force: true });
  const asarPath = join(helperResources, 'app.asar');
  const st = await stat(asarPath).catch(() => null);
  if (!st || st.size < 1024 * 100) {
    throw new Error(`Invalid helper package: missing app.asar (from ${basename(resourcesDir)})`);
  }
  return { helperExePath, launchPath, resourcesPath: helperResources };
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


