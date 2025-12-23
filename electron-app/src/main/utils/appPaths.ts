import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

export function appDirname(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}

export function resolvePreloadPath(baseDir: string): string {
  // В packaged сборке preload должен быть CommonJS (index.js).
  // Если случайно окажется и .mjs и .js — приоритетно берём .js.
  const candidates = [join(baseDir, '../preload/index.js'), join(baseDir, '../preload/index.mjs')];
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0];
}

export function resolveRendererIndex(baseDir: string): string {
  return join(baseDir, '../renderer/index.html');
}


