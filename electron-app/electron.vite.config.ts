import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        output: {
          // В Windows preload по умолчанию исполняется как CommonJS.
          // ESM preload (.mjs) может падать с "Cannot use import statement outside a module".
          format: 'cjs',
          // Явно используем .cjs, чтобы Electron не пытался интерпретировать как ESM.
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'dist/renderer',
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react()],
  },
});


