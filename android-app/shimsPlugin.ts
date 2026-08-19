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
      if (browser && source === 'node:fs/promises') return resolve(shimsDir, 'nodeFsPromises.ts');
      if (browser && source === 'node:path') return resolve(shimsDir, 'nodePath.ts');
      if (browser && (source === 'node:os' || source === 'os')) return resolve(shimsDir, 'nodeOs.ts');
      // Relative-импорты платформенных модулей ИЗ портированных main-сервисов —
      // без подмены они резолвятся в electron-версии (node:fs / better-sqlite3 / cipher).
      const fromPortedMain = !!importer && norm(importer).startsWith(electronMainDir);
      if (fromPortedMain) {
        if (source === './netFetch.js' || source.endsWith('/netFetch.js')) {
          return resolve(shimsDir, 'netFetch.ts');
        }
        // Watchdog — внешний десктоп-процесс; его handshake шимится и в vitest:
        // electron-шим app не имеет getPath, реальный модуль упал бы fire-and-forget'ом.
        if (source.endsWith('/watchdogHandshakeService.js')) return resolve(shimsDir, 'watchdogHandshake.ts');
        // Sidecar-копия сессии (%APPDATA%) — десктопный механизм на sync node:fs;
        // в браузерном бандле его нет, на планшете reset и так перекрыт портом.
        if (browser && source.endsWith('/sessionSidecarStore.js')) return resolve(shimsDir, 'sessionSidecarStore.ts');
        if (browser) {
          if (source.endsWith('/utils/logger.js')) return resolve(shimsDir, 'logger.ts');
          if (source.endsWith('/database/db.js')) return resolve(shimsDir, 'dbHandle.ts');
          if (source.endsWith('/sync/e2eCrypto.js')) return resolve(shimsDir, 'e2eCrypto.ts');
        }
      }
      return null;
    },
  };
}
