import { app, dialog, shell, net } from 'electron';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string }
  | { ok: false; error: string };

export function initAutoUpdate() {
  // Ничего не делаем: обновления идут не через GitHub (репозиторий приватный),
  // а через Яндекс.Диск (public link + latest.yml).
}

export function wireAutoUpdateDialogs(opts: {
  log: (msg: string) => void;
  getLogPath: () => string;
}) {
  // Автообновление через Яндекс.Диск: проверяем при запуске и показываем диалог.
  void (async () => {
    const check = await checkForUpdates();
    if (!check.ok) {
      opts.log(`update check failed: ${check.error}`);
      return;
    }
    if (!check.updateAvailable) return;

    const r = await dialog.showMessageBox({
      type: 'info',
      title: 'Доступно обновление',
      message: 'Найдена новая версия программы.',
      detail: `Новая версия: ${check.version ?? ''}\n\nЛог: ${opts.getLogPath()}`,
      buttons: ['Скачать обновление', 'Позже'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response !== 0) return;

    const dl = await downloadUpdate();
    if (!dl.ok) {
      opts.log(`download failed: ${dl.error ?? 'unknown'}`);
      await dialog.showMessageBox({
        type: 'error',
        title: 'Ошибка обновления',
        message: 'Не удалось скачать обновление.',
        detail: `${dl.error ?? 'unknown'}\n\nЛог: ${opts.getLogPath()}`,
      });
      return;
    }

    const r2 = await dialog.showMessageBox({
      type: 'question',
      title: 'Обновление готово',
      message: 'Обновление скачано. Установить сейчас?',
      detail: `Версия: ${check.version ?? ''}`,
      buttons: ['Установить и перезапустить', 'Позже'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r2.response !== 0) return;
    await quitAndInstall();
  })();
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

export async function downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
  try {
    const latest = await fetchLatestInfo();
    const filePath = await downloadInstallerWithFallback(latest);
    lastDownloadedInstallerPath = filePath;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function quitAndInstall(): Promise<{ ok: boolean; error?: string }> {
  try {
    const target = lastDownloadedInstallerPath ?? (await downloadInstallerWithFallback(await fetchLatestInfo()));
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

let cachedLatest: { version: string; path: string } | null = null;
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
  const yml = await downloadTextFromYandex(joinPosix(getBasePath(), 'latest.yml'));
  const info = parseLatestYml(yml);
  cachedLatest = info;
  return info;
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

async function downloadTextFromYandex(pathOnDisk: string): Promise<string> {
  const href = await getDownloadHref(pathOnDisk);
  const r = await net.fetch(href);
  if (!r.ok) throw new Error(`Yandex download failed ${r.status}`);
  return await r.text();
}

async function downloadFromYandex(fileName: string): Promise<string> {
  const href = await getDownloadHref(joinPosix(getBasePath(), fileName));
  const r = await net.fetch(href);
  if (!r.ok) throw new Error(`Yandex download failed ${r.status}`);

  const dir = join(app.getPath('temp'), 'MatricaRMZ-updates');
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, fileName);

  const ws = createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    r.body?.pipeTo
      ? // Web streams
        r.body
          .pipeTo(new WritableStream({
            write(chunk) {
              ws.write(Buffer.from(chunk));
            },
            close() {
              ws.end();
              resolve(undefined);
            },
            abort(err) {
              reject(err);
            },
          }))
          .catch(reject)
      : // Node stream fallback
        (r.body
          ? (r.body.on('data', (c) => ws.write(c)),
            r.body.on('end', () => {
              ws.end();
              resolve(undefined);
            }),
            r.body.on('error', reject))
          : reject(new Error('No response body')));
  });

  const s = await stat(outPath);
  if (s.size < 1024 * 100) {
    // слишком маленький файл — вероятно, скачали HTML/ошибку
    throw new Error('Downloaded installer looks too small');
  }
  return outPath;
}

async function downloadInstallerWithFallback(latest: { version: string; path: string }): Promise<string> {
  try {
    return await downloadFromYandex(latest.path);
  } catch (e) {
    const msg = String(e);
    // Если файл по имени из latest.yml не найден — попробуем найти любой .exe в папке basePath,
    // предпочтительно содержащий версию.
    if (!msg.includes('Yandex download href failed 404')) throw e;

    const folder = getBasePath();
    const items = await listPublicFolder(folder);
    const exe = pickInstaller(items, latest.version);
    if (!exe) {
      throw new Error(`Installer not found in ${folder}. latest.yml path=${latest.path}. Available: ${items.join(', ')}`);
    }
    return await downloadFromYandex(exe);
  }
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

function pickInstaller(items: string[], version: string): string | null {
  const exes = items.filter((n) => n.toLowerCase().endsWith('.exe'));
  if (exes.length === 0) return null;
  const byVersion = exes.find((n) => n.includes(version));
  return byVersion ?? exes[0] ?? null;
}

function parseLatestYml(yml: string): { version: string; path: string } {
  // electron-builder latest.yml содержит top-level "version:" и "path:".
  const version = pickYamlScalar(yml, 'version');
  const path = pickYamlScalar(yml, 'path');
  if (!version || !path) throw new Error('latest.yml parse failed (missing version/path)');
  return { version, path };
}

function pickYamlScalar(yml: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+)\\s*$`, 'm');
  const m = yml.match(re);
  if (!m) return null;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
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


