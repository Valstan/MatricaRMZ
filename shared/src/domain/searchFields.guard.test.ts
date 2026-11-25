import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SEARCH_FIELDS } from './searchFields.js';

// Реестр полей ведётся руками — значит он может разойтись со строкой списка.
// Поле, которого в строке нет, — это молчаливо пустая группа в выдаче: оператор
// увидит «по номеру двигателя — 0» и решит, что поиск сломан.

const TYPES_SOURCE = readFileSync(fileURLToPath(new URL('../ipc/types.ts', import.meta.url)), 'utf8');

function engineListItemSource(): string {
  const start = TYPES_SOURCE.indexOf('export type EngineListItem = {');
  expect(start, 'в shared/src/ipc/types.ts нет типа EngineListItem').toBeGreaterThan(-1);
  const end = TYPES_SOURCE.indexOf('\n};', start);
  return TYPES_SOURCE.slice(start, end === -1 ? undefined : end);
}

const ENGINE_ROW = engineListItemSource();

describe('реестр полей поиска и строка списка двигателей', () => {
  it('каждое поле двигателя реально есть в EngineListItem', () => {
    for (const field of SEARCH_FIELDS.engine ?? []) {
      const key = field.keys[0]!;
      expect(
        ENGINE_ROW.includes(`${key}?:`),
        `поле «${field.label}» ждёт ключ «${key}», которого нет в EngineListItem`,
      ).toBe(true);
    }
  });

  it('у каждого поля есть подпись и ключи — иначе группа вывода нечем назвать', () => {
    for (const [kind, fields] of Object.entries(SEARCH_FIELDS)) {
      for (const field of fields ?? []) {
        expect(field.label.trim(), `поле ${kind}/${field.id} без подписи`).not.toBe('');
        expect(field.keys.length, `поле ${kind}/${field.id} без ключей`).toBeGreaterThan(0);
      }
    }
  });

  it('идентификаторы поля уникальны внутри вида — иначе группа соберётся из двух полей', () => {
    for (const [kind, fields] of Object.entries(SEARCH_FIELDS)) {
      const ids = (fields ?? []).map((f) => f.id);
      expect(new Set(ids).size, `в виде ${kind} есть повторяющиеся id полей`).toBe(ids.length);
    }
  });
});
