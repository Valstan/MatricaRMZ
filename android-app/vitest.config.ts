import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { androidShims } from './shimsPlugin.js';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [androidShims({ target: 'vitest' })],
  resolve: {
    alias: {
      '@matricarmz/shared': resolve(here, '../shared/src/index.ts'),
    },
    // Один экземпляр drizzle на программу — см. комментарий в tsconfig.json.
    dedupe: ['drizzle-orm'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
