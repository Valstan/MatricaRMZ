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
  const preferred = join(app.getPath('downloads'), 'MatricaRMZ-Updates');
  if (ensureDir(preferred)) {
    cachedDefaultRoot = preferred;
    return cachedDefaultRoot;
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
