import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Хэш в имени ассета — обещание неизменяемости, которое надо дать и браузеру:
// иначе парк перекачивает неизменившееся при каждом заходе. Точка входа,
// наоборот, обязана проверяться заново всегда — иначе оператор увидит
// прошлый релиз админки после выката.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const APP = src('../app.ts');

describe('кэш статики админки', () => {
  it('хэшированные ассеты отдаются как immutable на год', () => {
    expect(APP).toContain("app.use('/admin-ui/assets'");
    expect(APP).toContain("maxAge: '1y', immutable: true");
  });

  it('точка входа проверяется заново всегда', () => {
    expect(APP, 'index.html из статики — no-cache, а не max-age=0').toContain(
      "if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');",
    );
    expect(APP, 'index.html из SPA-фолбэка — тоже no-cache').toContain("app.get('/admin-ui/*'");
  });
});
