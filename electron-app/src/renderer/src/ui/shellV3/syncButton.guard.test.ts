import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож значка синхронизации.
//
// Владелец 18.09.2026: «крутится вся кнопка, а надо только стрелку». Анимация висела на
// самой кнопке, вместе со значком вращалась её рамка. Починка держится ТРЕМЯ строками в
// двух файлах — отдельный элемент стрелки в разметке, `display:inline-block` у него (к
// строчному элементу transform не применяется вовсе) и селектор анимации через потомка.
// Порвать любую из них можно молча: и типы, и линт, и тесты останутся зелёными, а кнопка
// снова закрутится целиком.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const SHELL = src('./V3TabShell.tsx');
const CSS = src('./shellV3.css');

describe('крутится стрелка, а не кнопка', () => {
  it('стрелка в разметке — отдельный элемент', () => {
    expect(SHELL, 'исчез span.v3-sync-glyph вокруг стрелки').toContain('className="v3-sync-glyph"');
  });

  it('анимация назначена стрелке, а не кнопке', () => {
    expect(CSS).toMatch(/\.v3-sync-spinning\s+\.v3-sync-glyph\s*\{[^}]*animation:\s*v3-sync-spin/);
  });

  it('на самой кнопке вращения нет', () => {
    const buttonRule = CSS.match(/\.v3-sync-spinning\s*\{[^}]*\}/)?.[0] ?? '';
    expect(buttonRule, 'анимация вернулась на кнопку — закрутится вся рамка').not.toContain('animation');
  });

  it('стрелка блочная — иначе transform к ней не применится', () => {
    expect(CSS).toMatch(/\.v3-sync-glyph\s*\{[^}]*display:\s*inline-block/);
  });

  it('кадры вращения на месте', () => {
    expect(CSS).toContain('@keyframes v3-sync-spin');
  });
});
