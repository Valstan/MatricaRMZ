import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { androidShims } from '../../shimsPlugin.js';

// Сторож поверхности шимов планшетного порта.
//
// Планшет тянет в бандл НАСТОЯЩИЕ модули main-процесса Electron-клиента
// (`android-app/src/core/ipcWiring.ts`), а платформенное — через шимы
// (`android-app/shimsPlugin.ts`). Если портированный модуль возьмёт API, которого
// в шиме нет, сборка планшета падает на rollup: «X is not exported by …».
//
// Так и случилось 23.11.2026 (PR #1974): канал «показать файл выгрузки» в
// `ipc/register/authAndSync.ts` взял `existsSync` из 'node:fs' и `shell` из
// 'electron' — и гейт сборки APK покраснел. Класс дефекта ловится и без CI:
// этот сторож проверяет, что поверхность шимов покрывает всё, что портированные
// модули реально импортируют.
//
// Проверка намеренно поверхностная (модули, которые планшет регистрирует явно):
// более глубокие зависимости ловит сборка планшета — она и есть последний рубеж.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const wiringPath = resolve(here, '../core/ipcWiring.ts');
const shimPlugin = androidShims({ target: 'browser' });

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Имя из части списка импортов: `type X`, `X as Y` → `X`. */
function importedName(part: string): string {
  return (part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '').trim();
}

/** Имена, экспортируемые модулем (без default). */
function exportedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:const|function|class|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1] as string);
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] as string).split(',')) {
      const name = importedName(part);
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Именованные импорты файла по спецификатору.
 *
 * Регекс « tempered dot»: между `import` и `from` не может быть другого
 * `import` — иначе один оператор всасывает в себя соседние.
 */
function namedImports(text: string, specifier: string): string[] {
  const out: string[] = [];
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\bimport\\s+(?!type\\b)((?:(?!import\\s)[\\s\\S])*?)\\s+from\\s*['"]${escaped}['"]`,
    'g',
  );
  for (const m of text.matchAll(re)) {
    const clause = m[1] as string;
    const brace = clause.match(/\{([\s\S]*)\}/);
    if (!brace) continue;
    for (const part of (brace[1] as string).split(',')) {
      const name = importedName(part);
      if (name) out.push(name);
    }
  }
  return out;
}

/** Спецификаторы 'node:*', из которых модуль берёт именованные импорты. */
function nodeSpecifiers(text: string): string[] {
  const out = new Set<string>();
  const re = /\bimport\s+(?!type\b)((?:(?!import\s)[\s\S])*?)\s+from\s*['"](node:[^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    const clause = m[1] as string;
    if (!clause.includes('{')) continue; // namespace-импорт имена не проверяет
    out.add(m[2] as string);
  }
  return [...out];
}

/** Модули main-процесса, которые планшет регистрирует явно. */
function wiredMainModules(): string[] {
  const text = read(wiringPath);
  const out: string[] = [];
  for (const m of text.matchAll(/from\s*['"]([^'"]*electron-app\/src\/main\/[^'"]+)['"]/g)) {
    const spec = m[1] as string;
    out.push(resolve(repoRoot, 'android-app/src/core', spec).replace(/\.js$/, '.ts'));
  }
  return [...new Set(out)];
}

describe('поверхность шимов покрывает то, что тянет планшет', () => {
  it('модули, которые планшет регистрирует, найдены', () => {
    expect(wiredMainModules().length).toBeGreaterThan(10);
  });

  it('каждый именованный импорт из electron закрыт шимом', () => {
    const shimPath = shimPlugin.resolveId('electron', undefined);
    expect(shimPath, 'шим electron не найден').toBeTruthy();
    const shimExports = exportedNames(read(shimPath as string));

    const uncovered: string[] = [];
    for (const file of wiredMainModules()) {
      const text = read(file);
      for (const name of namedImports(text, 'electron')) {
        if (!shimExports.has(name)) uncovered.push(`${file}: electron.${name}`);
      }
    }
    expect(uncovered, 'шим electron не покрывает импорты портированных модулей').toEqual([]);
  });

  it('каждый именованный импорт из node:* закрыт шимом', () => {
    const uncovered: string[] = [];
    for (const file of wiredMainModules()) {
      const text = read(file);
      for (const specifier of nodeSpecifiers(text)) {
        const shimPath = shimPlugin.resolveId(specifier, file);
        if (!shimPath) {
          uncovered.push(`${file}: ${specifier} (шима нет)`);
          continue;
        }
        const shimExports = exportedNames(read(shimPath));
        for (const name of namedImports(text, specifier)) {
          if (!shimExports.has(name)) uncovered.push(`${file}: ${specifier} → ${name}`);
        }
      }
    }
    expect(uncovered, 'шим node:* не покрывает импорты портированных модулей').toEqual([]);
  });
});
