import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  decideUnresolvedReferenceClick,
  findUniqueExactReference,
  hasUnresolvedEntityReference,
  type ReferenceClickTarget,
} from './EntityReferenceField.js';

describe('findUniqueExactReference', () => {
  const options = [
    { id: 'one', label: 'Коленчатый вал' },
    { id: 'two', label: 'Шатун' },
  ];

  it('resolves one normalized exact match', () => {
    expect(findUniqueExactReference('  КОЛЕНЧАТЫЙ   ВАЛ ', options)?.id).toBe('one');
  });

  it('does not guess when exact labels are duplicated', () => {
    expect(findUniqueExactReference('шатун', [...options, { id: 'three', label: 'ШАТУН' }])).toBeNull();
  });

  it('does not accept a merely similar label', () => {
    expect(findUniqueExactReference('вал', options)).toBeNull();
  });

  it('ignores punctuation/spacing differences (в84 → В-84)', () => {
    expect(findUniqueExactReference('в84', [{ id: 'brand', label: 'В-84' }])?.id).toBe('brand');
    expect(findUniqueExactReference('В 84', [{ id: 'brand', label: 'В-84' }])?.id).toBe('brand');
  });

  it('stays null when compact labels collide', () => {
    expect(
      findUniqueExactReference('в84', [
        { id: 'a', label: 'В-84' },
        { id: 'b', label: 'В 84' },
      ]),
    ).toBeNull();
  });
});

describe('hasUnresolvedEntityReference', () => {
  const selected = { id: 'part-1', label: 'Коленчатый вал' };

  it('blocks actions while typed text has no committed id', () => {
    expect(hasUnresolvedEntityReference('Новая деталь', null, null)).toBe(true);
  });

  it('allows actions for the selected label and for an empty field', () => {
    expect(hasUnresolvedEntityReference('  КОЛЕНЧАТЫЙ   ВАЛ ', selected.id, selected)).toBe(false);
    expect(hasUnresolvedEntityReference('', null, null)).toBe(false);
  });
});

// Залипание фокуса «между текстурами»: пока в поле висит неразобранный текст, поле ловило
// ЛЮБОЙ клик в окне и съедало его. Оператор целился в соседнее поле — и оно не принимало
// ввод. Решение о судьбе клика вынесено сюда, в чистую функцию, и сторожится по свойствам.
describe('decideUnresolvedReferenceClick', () => {
  function target(patch: Partial<ReferenceClickTarget> = {}): ReferenceClickTarget {
    return { insideField: false, tagName: 'BUTTON', inputType: null, editable: false, ...patch };
  }
  const unresolved = { unresolved: true, resolving: false };

  it('ничего не перехватывает, когда неразрешённого текста нет', () => {
    expect(decideUnresolvedReferenceClick(target(), { unresolved: false, resolving: false })).toBe('ignore');
    expect(
      decideUnresolvedReferenceClick(target({ tagName: 'INPUT', inputType: 'text' }), {
        unresolved: false,
        resolving: false,
      }),
    ).toBe('ignore');
  });

  it('пропускает клик по другому полю ввода — фокус обязан уйти туда', () => {
    expect(decideUnresolvedReferenceClick(target({ tagName: 'INPUT', inputType: 'text' }), unresolved)).toBe('resolve');
    expect(decideUnresolvedReferenceClick(target({ tagName: 'INPUT', inputType: null }), unresolved)).toBe('resolve');
    expect(decideUnresolvedReferenceClick(target({ tagName: 'INPUT', inputType: 'number' }), unresolved)).toBe('resolve');
    expect(decideUnresolvedReferenceClick(target({ tagName: 'TEXTAREA' }), unresolved)).toBe('resolve');
    expect(decideUnresolvedReferenceClick(target({ tagName: 'SELECT' }), unresolved)).toBe('resolve');
    expect(decideUnresolvedReferenceClick(target({ tagName: 'DIV', editable: true }), unresolved)).toBe('resolve');
  });

  it('блокирует клик по кнопке, ссылке и по input-действию', () => {
    expect(decideUnresolvedReferenceClick(target({ tagName: 'BUTTON' }), unresolved)).toBe('resolve-and-block');
    expect(decideUnresolvedReferenceClick(target({ tagName: 'A' }), unresolved)).toBe('resolve-and-block');
    expect(decideUnresolvedReferenceClick(target({ tagName: 'INPUT', inputType: 'checkbox' }), unresolved)).toBe(
      'resolve-and-block',
    );
    expect(decideUnresolvedReferenceClick(target({ tagName: 'INPUT', inputType: 'submit' }), unresolved)).toBe(
      'resolve-and-block',
    );
  });

  it('не трогает клик внутри самого поля и его выпадашки', () => {
    expect(decideUnresolvedReferenceClick(target({ insideField: true }), unresolved)).toBe('ignore');
    expect(
      decideUnresolvedReferenceClick(target({ insideField: true, tagName: 'INPUT', inputType: 'text' }), unresolved),
    ).toBe('ignore');
  });

  it('игнорирует повторный клик, пока идёт разбор (диалог уже открыт)', () => {
    expect(decideUnresolvedReferenceClick(target(), { unresolved: true, resolving: true })).toBe('ignore');
    expect(
      decideUnresolvedReferenceClick(target({ tagName: 'INPUT', inputType: 'text' }), {
        unresolved: true,
        resolving: true,
      }),
    ).toBe('ignore');
  });
});

// Сторож по исходнику: свойства, которые нельзя проверить чистой функцией, но потеря
// которых возвращает залипание — и возвращает молча.
describe('EntityReferenceField: перехватчик кликов', () => {
  const source = readFileSync(fileURLToPath(new URL('./EntityReferenceField.tsx', import.meta.url)), 'utf8');

  it('подписка на mousedown стоит под условием «есть неразрешённый текст»', () => {
    const subscriptions = source.match(/document\.addEventListener\('mousedown'/g) ?? [];
    expect(subscriptions).toHaveLength(1);
    const guard = source.indexOf('if (!unresolved) return undefined;');
    const attach = source.indexOf("document.addEventListener('mousedown'");
    const deps = source.indexOf('}, [unresolved]);');
    expect(guard).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(guard);
    expect(deps).toBeGreaterThan(attach);
  });

  it('флаг «уже разрешаем» ставится до диалога и снимается в finally', () => {
    const flagUp = source.indexOf('resolvingRef.current = true;');
    const dialog = source.indexOf('await confirm?.pickChoice(');
    const flagDown = source.indexOf('resolvingRef.current = false;');
    expect(flagUp).toBeGreaterThan(-1);
    expect(flagUp).toBeLessThan(dialog);
    expect(source.slice(flagDown - 60, flagDown)).toContain('} finally {');
  });
});
