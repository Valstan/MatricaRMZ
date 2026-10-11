import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// `web-admin/dist` раздаётся публично через `express.static`, а URL карты кода
// угадывается из имени JS-файла — поэтому `sourcemap: 'hidden'` не лечит
// (файл всё равно лежит в dist и отдаётся по прямому URL), только не выпускать.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const VITE_CONFIG = src('../../../web-admin/vite.config.ts');

describe('карты кода админки не уезжают на прод', () => {
  it('сборка web-admin не выпускает sourcemap', () => {
    expect(VITE_CONFIG).toContain('sourcemap: false');
    expect(VITE_CONFIG).not.toContain('sourcemap: true');
    expect(VITE_CONFIG).not.toContain("sourcemap: 'hidden'");
  });
});
