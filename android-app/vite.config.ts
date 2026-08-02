import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// F0 spike: build the EXISTING Electron renderer as a plain web app.
// The renderer is not moved — this config points at electron-app/src/renderer
// (see docs/plans/android-tablet-client-2026-08.md, «Ключевые решения» #1).
const here = fileURLToPath(new URL('.', import.meta.url));
const rendererRoot = resolve(here, '../electron-app/src/renderer');

export default defineConfig({
  root: 'src',
  base: './',
  publicDir: resolve(rendererRoot, 'public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@matricarmz/shared': resolve(here, '../shared/src/index.ts'),
      '@renderer': resolve(rendererRoot, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    fs: { allow: [resolve(here, '..')] },
  },
  preview: { host: '127.0.0.1', port: 5199 },
  build: { outDir: resolve(here, 'dist'), emptyOutDir: true },
});
