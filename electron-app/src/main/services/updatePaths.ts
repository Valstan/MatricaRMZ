import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

let cachedRoot: string | null = null;

function ensureDir(path: string) {
  try {
    mkdirSync(path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function getUpdatesRootDir() {
  if (cachedRoot) return cachedRoot;
  const env = String(process.env.MATRICA_UPDATE_CACHE_DIR ?? '').trim();
  if (env) {
    cachedRoot = env;
    ensureDir(cachedRoot);
    return cachedRoot;
  }
  const preferred = join(app.getPath('downloads'), 'MatricaRMZ-Updates');
  if (ensureDir(preferred)) {
    cachedRoot = preferred;
    return cachedRoot;
  }
  const fallback = join(app.getPath('userData'), 'MatricaRMZ-Updates');
  ensureDir(fallback);
  cachedRoot = fallback;
  return cachedRoot;
}
