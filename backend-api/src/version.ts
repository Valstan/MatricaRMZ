import { createRequire } from 'node:module';

// Важно: backend собирается tsc в ESM (dist/*.js).
// JSON import в Node ESM требует assert, поэтому читаем package.json через createRequire.
const require = createRequire(import.meta.url);

type PackageJson = { version?: string };

export const backendVersion = String((require('../package.json') as PackageJson)?.version ?? '0.0.0');


