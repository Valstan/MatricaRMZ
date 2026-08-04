import { app } from 'electron';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';

/**
 * Каталог установки до 2026-08: electron-builder при `oneClick` + `perMachine: false`
 * берёт имя папки из `name` пакета (`@matricarmz/electron-app`), а не из `productName` —
 * см. getWindowsInstallationDirName(appInfo, !oneClick || isPerMachine) в app-builder-lib.
 * Новый путь задаётся installer.nsh через реестр; сюда клиент приходит подчистить прежний.
 */
export const LEGACY_INSTALL_DIR_NAME = '@matricarmzelectron-app';

/** Лежит ли `target` внутри `dir` (или это он сам). Без обращения к ФС. */
export function isPathInsideDir(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

let cachedDefaultRoot: string | null = null;
let configuredRoot: string | null = null;

function ensureDir(path: string) {
  try {
    mkdirSync(path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function getUpdatesRootDir() {
  const env = String(process.env.MATRICA_UPDATE_CACHE_DIR ?? '').trim();
  if (env) {
    ensureDir(env);
    return env;
  }
  if (configuredRoot) {
    ensureDir(configuredRoot);
    return configuredRoot;
  }
  if (cachedDefaultRoot) return cachedDefaultRoot;
  // Кэш обновлений — сиблинг каталога установки под "$LOCALAPPDATA\Programs", а не
  // «Загрузки» (дефолт до 2026-08). Причина не в удобстве: постоянный 136-МБ .exe с
  // предсказуемым именем в самой сканируемой папке Windows читается эвристикой как
  // дроппер, а держать ВСЕ исполняемые продукта под одним родителем — единственный
  // способ накрыть их одним исключением антивируса (плана А, разбор 2026-08-04).
  // Electron не отдаёт localAppData через getPath — берём из env, с прежним фолбэком.
  const localAppData = process.platform === 'win32' ? String(process.env.LOCALAPPDATA ?? '').trim() : '';
  if (localAppData) {
    const preferred = join(localAppData, 'Programs', 'MatricaRMZ-Updates');
    if (ensureDir(preferred)) {
      cachedDefaultRoot = preferred;
      return cachedDefaultRoot;
    }
  }
  const fallback = join(app.getPath('userData'), 'MatricaRMZ-Updates');
  ensureDir(fallback);
  cachedDefaultRoot = fallback;
  return cachedDefaultRoot;
}

export function setConfiguredUpdatesRootDir(path: string | null | undefined) {
  const next = String(path ?? '').trim();
  configuredRoot = next || null;
  if (configuredRoot) ensureDir(configuredRoot);
}

/**
 * Разовая подчистка прежнего кэша обновлений в «Загрузках».
 *
 * Установщик сделать этого не может: он сам ЗАПУЩЕН из этого каталога (старый клиент
 * кладёт туда `matrica_rmz_update.exe` и открывает его на месте), а образ работающего
 * процесса Windows удалить не даёт — `RMDir /r` в `customInit` оставляет ровно тот
 * 136-МБ .exe, ради выноса которого переезд и делался. К моменту старта нового клиента
 * установщик уже завершён, замка нет.
 *
 * Только дефолтный путь: если оператор задал свой каталог (env или настройка), он тут
 * ни при чём. Не трогаем и когда кэш всё ещё указывает в «Загрузки» (переезд не состоялся).
 */
export function sweepLegacyDownloadsCache(onLog?: (line: string) => void): void {
  if (process.platform !== 'win32') return;
  if (String(process.env.MATRICA_UPDATE_CACHE_DIR ?? '').trim() || configuredRoot) return;
  const legacy = join(app.getPath('downloads'), 'MatricaRMZ-Updates');
  if (getUpdatesRootDir() === legacy) return;
  try {
    if (!existsSync(legacy)) return;
    rmSync(legacy, { recursive: true, force: true });
    onLog?.(`legacy updates cache removed: ${legacy}`);
  } catch (e) {
    // Не критично: каталог подберётся при следующем запуске либо руками.
    onLog?.(`legacy updates cache cleanup failed: ${String(e)}`);
  }
}

/**
 * Разовая подчистка прежнего каталога установки (`Programs\@matricarmzelectron-app`).
 *
 * Делает это клиент, а не установщик, по той же причине, что и с кэшем обновлений: на
 * момент установки старый каталог ещё может держать запущенный процесс, а к первому
 * старту нового клиента он свободен. Плюс страховка: если клиент почему-то запущен
 * ИЗ старого каталога (переезд не состоялся), каталог не трогаем — иначе снесли бы
 * образ работающего процесса.
 */
export function sweepLegacyInstallDir(onLog?: (line: string) => void): void {
  if (process.platform !== 'win32') return;
  const localAppData = String(process.env.LOCALAPPDATA ?? '').trim();
  if (!localAppData) return;
  const legacy = join(localAppData, 'Programs', LEGACY_INSTALL_DIR_NAME);
  try {
    if (!existsSync(legacy)) return;
    if (isPathInsideDir(legacy, process.execPath)) {
      onLog?.(`legacy install dir kept (running from it): ${legacy}`);
      return;
    }
    rmSync(legacy, { recursive: true, force: true });
    onLog?.(`legacy install dir removed: ${legacy}`);
  } catch (e) {
    onLog?.(`legacy install dir cleanup failed: ${String(e)}`);
  }
}
