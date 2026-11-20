import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Контракт моста `window.matrica`: preload и shared-тип должны совпадать.
 *
 * Ловится молча: тип в `shared/src/ipc/types.ts` объявляет раздел, рендерер по нему
 * пишет `window.matrica.<раздел>.<метод>()`, а preload этот раздел не отдаёт — и
 * вызов падает в рендерере. Именно так сломалось «Почта»: `window.matrica.mail`
 * в preload не было никогда (смоук меню ПП, 20.11.2026) — окно письма открывалось,
 * а вложение не собиралось, и оператор видел «готовим файл…» до бесконечности.
 *
 * Компилятор это не видит: `matricaApi` в preload — обычный объект без проверки по
 * `MatricaApi`. Сторож — единственный, кто сравнивает стороны.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

/**
 * Ключи верхнего уровня объявления: идём по тексту и считаем скобки.
 *
 * Разбор текстом, а не импорт типа: в preload объект обычный, импортировать его
 * нельзя (там electron), а в shared-типе ключи — свойства вложенных объектов.
 */
function topLevelKeys(source: string, header: string): string[] {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`не найдено объявление: ${header}`);
  const keys: string[] = [];
  let depth = 0;
  for (const raw of source.slice(start).split('\n')) {
    const line = raw.trim();
    if (depth === 1) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/.exec(line);
      if (match?.[1]) keys.push(match[1]);
    }
    for (const ch of raw) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth === 0) break;
  }
  return keys;
}

const CONTRACT = topLevelKeys(read('shared/src/ipc/types.ts'), 'export type MatricaApi = {');
const PRELOAD = topLevelKeys(read('electron-app/src/preload/index.ts'), 'const matricaApi = {');

describe('мост window.matrica: preload отдаёт всё, что обещает контракт', () => {
  it('разделы контракта есть в preload', () => {
    const missing = CONTRACT.filter((key) => !PRELOAD.includes(key));
    expect(missing, `в preload нет разделов: ${missing.join(', ')}`).toEqual([]);
  });

  it('preload не отдаёт ничего сверх контракта', () => {
    const extra = PRELOAD.filter((key) => !CONTRACT.includes(key));
    expect(extra, `в preload есть разделы вне контракта: ${extra.join(', ')}`).toEqual([]);
  });

  it('письмо с вложением — раздел есть и в preload, и в контракте', () => {
    expect(CONTRACT).toContain('mail');
    expect(PRELOAD).toContain('mail');
    const preload = read('electron-app/src/preload/index.ts');
    expect(preload).toContain("ipcRenderer.invoke('mail:prepareAttachment'");
    expect(preload).toContain("ipcRenderer.invoke('mail:openDraft'");
  });
});
