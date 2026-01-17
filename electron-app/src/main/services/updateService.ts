import { app, BrowserWindow, shell, net } from 'electron';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string }
  | { ok: false; error: string };

export function initAutoUpdate() {
  // Обновления идут через Яндекс.Диск (public folder).
}

let updateInFlight = false;
let updateUiWindow: BrowserWindow | null = null;

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
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
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

export async function runAutoUpdateFlow(opts: { reason: 'startup' | 'manual_menu'; parentWindow?: BrowserWindow | null } = { reason: 'startup' }) {
  if (updateInFlight) return;
  updateInFlight = true;
  try {
    const check = await checkForUpdates();
    if (!check.ok) {
      // Ошибку показываем кратко и не блокируем работу.
      showUpdateWindow(opts.parentWindow ?? null);
      await setUpdateUi(`Ошибка проверки: ${check.error}`, 0);
      setTimeout(() => updateUiWindow?.close(), 3500);
      return;
    }
    if (!check.updateAvailable) {
      return;
    }

    showUpdateWindow(opts.parentWindow ?? null);
    await setUpdateUi('Проверяем обновления…', 0);
    await setUpdateUi(`Найдена новая версия. Скачиваем…`, 5, check.version);
    const latest = await fetchLatestInfo();
    const filePath = await downloadInstaller(latest.fileName, (pct) => setUpdateUi('Скачиваем обновление…', pct, latest.version));
    lastDownloadedInstallerPath = filePath;
    await setUpdateUi('Скачивание завершено. Готовим установку…', 95, latest.version);
    await setUpdateUi('Запускаем установку. Идёт замена версии…', 100, latest.version);
    const install = await quitAndInstall();
    if (!install.ok) {
      await setUpdateUi(`Ошибка установки: ${install.error ?? 'unknown'}`, 100, latest.version);
      setTimeout(() => updateUiWindow?.close(), 3500);
      return;
    }
  } finally {
    updateInFlight = false;
  }
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  try {
    const latest = await fetchLatestInfo();
    const current = app.getVersion();
    const updateAvailable = compareSemver(latest.version, current) > 0;
    return { ok: true, updateAvailable, version: latest.version };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function quitAndInstall(): Promise<{ ok: boolean; error?: string }> {
  try {
    const target = lastDownloadedInstallerPath ?? (await downloadInstaller((await fetchLatestInfo()).fileName));
    const err = await shell.openPath(target);
    if (err) return { ok: false, error: err };
    app.quit();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ------------------------
// Yandex.Disk public update source
// ------------------------

type ReleaseInfo = {
  releaseDate?: string;
  update?: {
    provider?: 'yandex';
    yandexPublicKey?: string;
    yandexBasePath?: string; // например: "latest"
  };
};

let cachedLatest: { version: string; fileName: string } | null = null;
let lastDownloadedInstallerPath: string | null = null;

function readReleaseInfo(): ReleaseInfo | null {
  try {
    const p = join(app.getAppPath(), 'release-info.json');
    const raw = readFileSync(p, 'utf8');
    return JSON.parse(raw) as ReleaseInfo;
  } catch {
    return null;
  }
}

function getPublicKey() {
  const fromEnv = process.env.MATRICA_UPDATE_YANDEX_PUBLIC_KEY;
  if (fromEnv) return fromEnv;

  const info = readReleaseInfo();
  const fromBundled = info?.update?.yandexPublicKey;
  if (fromBundled) return fromBundled;

  // Нет public_key => обновления отключены/не настроены.
  throw new Error('Yandex updater is not configured (missing yandexPublicKey)');
}

function getBasePath() {
  const fromEnv = process.env.MATRICA_UPDATE_YANDEX_BASE_PATH;
  if (fromEnv) return normalizePublicPath(fromEnv);

  const info = readReleaseInfo();
  const fromBundled = info?.update?.yandexBasePath;
  if (fromBundled) return normalizePublicPath(fromBundled);

  // По умолчанию ожидаем, что public_key указывает на папку "/matricarmz"
  // и внутри неё есть подпапка "latest".
  return 'latest';
}

async function fetchLatestInfo(): Promise<{ version: string; path: string }> {
  if (cachedLatest) return cachedLatest;

  // Новая стратегия: в /latest лежит один .exe. Определяем “последний” по версии из имени файла.
  const folder = getBasePath();
  const items = await listPublicFolder(folder);
  const exe = pickNewestInstaller(items);
  if (!exe) throw new Error(`No installer .exe found in ${folder}`);
  const version = extractVersionFromFileName(exe);
  if (!version) throw new Error(`Cannot extract version from installer name: ${exe}`);
  cachedLatest = { version, fileName: exe };
  return cachedLatest;
}

function joinPosix(a: string, b: string) {
  const aa = a.replaceAll('\\', '/').replace(/\/+$/, '');
  const bb = b.replaceAll('\\', '/').replace(/^\/+/, '');
  return `${aa}/${bb}`;
}

function normalizePublicPath(p: string) {
  // Для public/resources/download path должен быть путём ВНУТРИ опубликованного ресурса.
  // На практике API ожидает ведущий "/", иначе часто возвращает 404.
  const out = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return out.startsWith('/') ? out : `/${out}`;
}

async function getDownloadHref(pathOnDisk: string): Promise<string> {
  const api =
    'https://cloud-api.yandex.net/v1/disk/public/resources/download?' +
    new URLSearchParams({
      public_key: getPublicKey(),
      path: normalizePublicPath(pathOnDisk),
    }).toString();
  const r = await net.fetch(api);
  if (!r.ok) throw new Error(`Yandex download href failed ${r.status} (path=${normalizePublicPath(pathOnDisk)})`);
  const json = await r.json().catch(() => ({}));
  if (!json?.href) throw new Error('Yandex API returned no href');
  return json.href;
}

async function downloadInstaller(fileName: string, onProgress?: (pct: number) => void): Promise<string> {
  const href = await getDownloadHref(joinPosix(getBasePath(), fileName));
  const r = await net.fetch(href);
  if (!r.ok) throw new Error(`Yandex download failed ${r.status}`);

  const dir = join(app.getPath('temp'), 'MatricaRMZ-updates');
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, fileName);

  const total = Number(r.headers.get('content-length') ?? '0') || 0;
  const ws = createWriteStream(outPath);
  let received = 0;

  // Web stream путь (electron.net.fetch обычно отдаёт web stream)
  if ((r.body as any)?.getReader) {
    const reader = (r.body as any).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      ws.write(buf);
      received += buf.length;
      if (total > 0 && onProgress) onProgress((received / total) * 100);
    }
              ws.end();
  } else if (r.body) {
    // Node stream fallback (без прогресса если нет content-length)
    await new Promise<void>((resolve, reject) => {
      (r.body as any).on('data', (c: Buffer) => {
        ws.write(c);
        received += c.length;
        if (total > 0 && onProgress) onProgress((received / total) * 100);
      });
      (r.body as any).on('end', () => {
              ws.end();
        resolve();
      });
      (r.body as any).on('error', reject);
    });
  } else {
    throw new Error('No response body');
  }

  const s = await stat(outPath);
  if (s.size < 1024 * 100) {
    // слишком маленький файл — вероятно, скачали HTML/ошибку
    throw new Error('Downloaded installer looks too small');
  }
  return outPath;
}

async function listPublicFolder(pathOnDisk: string): Promise<string[]> {
  const api =
    'https://cloud-api.yandex.net/v1/disk/public/resources?' +
    new URLSearchParams({
      public_key: getPublicKey(),
      path: normalizePublicPath(pathOnDisk),
      limit: '200',
    }).toString();

  const r = await net.fetch(api);
  if (!r.ok) throw new Error(`Yandex list failed ${r.status} (path=${normalizePublicPath(pathOnDisk)})`);
  const json = (await r.json()) as any;
  const items = (json?._embedded?.items ?? []) as any[];
  return items.map((x) => String(x?.name ?? '')).filter(Boolean);
}

function extractVersionFromFileName(fileName: string): string | null {
  // Поддерживаем имена вроде:
  // - MatricaRMZ-Setup-0.0.23.exe
  // - MatricaRMZ Setup 0.0.23.exe
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


