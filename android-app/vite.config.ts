import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { androidShims } from './shimsPlugin.js';

// F0 spike: build the EXISTING Electron renderer as a plain web app.
// The renderer is not moved — this config points at electron-app/src/renderer
// (see docs/plans/android-tablet-client-2026-08.md, «Ключевые решения» #1).
const here = fileURLToPath(new URL('.', import.meta.url));
const rendererRoot = resolve(here, '../electron-app/src/renderer');

// Версия и адрес сервера — на этапе сборки: на планшете нет ни process.env,
// ни package.json. Версия общая для всего репо (CalVer из VERSION), адрес —
// умолчание ПЕРВОЙ установки, дальше правится настройкой внутри БД.
const appVersion = readFileSync(resolve(here, '../VERSION'), 'utf8').trim();
const defaultApiBaseUrl = process.env.MATRICA_API_URL ?? 'https://a6fd55b8e0ae.vps.myjino.ru';

export default defineConfig({
  root: 'src',
  base: './',
  publicDir: resolve(rendererRoot, 'public'),
  plugins: [androidShims({ target: 'browser' }), react()],
  define: {
    __MATRICA_APP_VERSION__: JSON.stringify(appVersion),
    __MATRICA_DEFAULT_API_BASE_URL__: JSON.stringify(defaultApiBaseUrl),
  },
  resolve: {
    alias: {
      '@matricarmz/shared': resolve(here, '../shared/src/index.ts'),
      '@renderer': resolve(rendererRoot, 'src'),
    },
    // drizzle-orm — см. комментарий в tsconfig.json: под pnpm у android-app и
    // electron-app разные физические копии, в бандл должна попасть одна.
    dedupe: ['react', 'react-dom', 'drizzle-orm'],
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    fs: { allow: [resolve(here, '..')] },
  },
  preview: { host: '127.0.0.1', port: 5199 },
  build: { outDir: resolve(here, 'dist'), emptyOutDir: true },
});
