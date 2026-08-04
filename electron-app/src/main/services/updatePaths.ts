import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
