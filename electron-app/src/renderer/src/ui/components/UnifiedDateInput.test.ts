import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { formatDateInputValue, parseDateInputValue } from './UnifiedDateInput.js';

describe('UnifiedDateInput local values', () => {
  it('round-trips a date-time through local calendar fields', () => {
    const parsed = parseDateInputValue('2026-07-24T08:15', true);
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(6);
    expect(parsed?.getDate()).toBe(24);
    expect(parsed?.getHours()).toBe(8);
    expect(formatDateInputValue(parsed, true)).toBe('2026-07-24T08:15');
  });

  it('formats a date without UTC conversion', () => {
    expect(formatDateInputValue(new Date(2026, 6, 24, 23, 30), false)).toBe('2026-07-24');
  });
});

// Проброс атрибутов до самого поля (найдено CDP-смоуком 2026-09-08, юнит-тесты этого не видели).
//
// Датапикер подменяет input своим (`customInput`), поэтому `title` и `data-*` вызывающего
// до DOM не доезжали: снаружи код выглядел рабочим — `<Input type="date" title="Дата прихода: по" />` —
// а в живом клиенте у поля не было ни подсказки оператору, ни зацепки для смоука. Сторож держит
// сам факт проброса: он рвётся молча и виден только в браузере.
describe('UnifiedDateInput пробрасывает атрибуты в поле', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./UnifiedDateInput.tsx', import.meta.url)), 'utf8');

  it('собирает title и data-* вызывающего', () => {
    expect(SRC).toContain('const passThroughAttrs: Record<string, unknown> = {');
    expect(SRC).toContain("...(props.title != null ? { title: props.title } : {})");
    expect(SRC).toContain("Object.entries(props).filter(([key]) => key.startsWith('data-'))");
  });

  it('и отдаёт их именно тому input, который рисует датапикер', () => {
    expect(SRC).toContain('{...passThroughAttrs}');
    expect(SRC.indexOf('{...passThroughAttrs}')).toBeGreaterThan(SRC.indexOf('customInput={'));
  });
});
