import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@matricarmz/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  base: '/admin-ui/',
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/')) return 'vendor';
          if (id.includes('/shared/src/')) return 'shared';
          return undefined;
        },
      },
    },
  },
});
