// Vite-плагин подмены модулей для android-порта (план, «Ключевые решения» §2:
// сервисы Electron-клиента импортируются напрямую, платформенное — через шимы).
//
// Два охвата:
//  - browser (vite build/dev): шимится всё платформенное — 'electron',
//    'node:crypto', relative './netFetch.js' из портированных сервисов;
//  - vitest (node): шимится ТОЛЬКО 'electron' и netFetch — нативные node:*
//    в тестах работают как есть (и нужны drizzle-мигратору в парити-гейте).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Намеренно НЕ типизируем через vite'овский Plugin: android-app сидит на vite 5,
// а vitest 4 тянет vite 7 — их Plugin-типы несовместимы под
// exactOptionalPropertyTypes. Структурный объект подходит обоим.
type ShimPlugin = {
  name: string;
  enforce: 'pre';
  resolveId(source: string, importer: string | undefined): string | null;
};

const here = fileURLToPath(new URL('.', import.meta.url));
const shimsDir = resolve(here, 'src/shims');
const electronMainDir = resolve(here, '../electron-app/src/main').replace(/\\/g, '/');

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

export function androidShims(opts: { target: 'browser' | 'vitest' }): ShimPlugin {
  const browser = opts.target === 'browser';
  return {
    name: 'android-shims',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'electron') return resolve(shimsDir, 'electron.ts');
      if (browser && (source === 'node:crypto' || source === 'crypto')) {
        return resolve(shimsDir, 'nodeCrypto.ts');
      }
      // netFetch подменяется только у портированных main-сервисов —
      // их relative-импорт './netFetch.js' резолвился бы в electron-версию.
      if (
        importer &&
        norm(importer).startsWith(electronMainDir) &&
        (source === './netFetch.js' || source.endsWith('/netFetch.js'))
      ) {
        return resolve(shimsDir, 'netFetch.ts');
      }
      return null;
    },
  };
}
