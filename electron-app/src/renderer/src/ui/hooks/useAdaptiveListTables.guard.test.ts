import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Замер ширин идёт позиционно (`rowCells[r]?.[col]`), а `colSpan` он не знает:
// полноширинная полка редактора попадала под индекс колонки «Дата» — её кнопки
// взводили чужой минимум 22ch, а текст ошибки уходил в чужую выборку длин.
// Полноширинная ячейка не принадлежит ни одной колонке, поэтому оба прохода
// (замер и подсказки) её пропускают.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const HOOK = src('./useAdaptiveListTables.ts');

describe('замер колонок не видит полноширинные ячейки', () => {
  it('оба прохода по ячейкам пропускают ячейку с colSpan', () => {
    const hits = HOOK.match(/cell\.colSpan > 1/g) ?? [];
    expect(
      hits.length,
      'замер и подсказки: полноширинная ячейка не принадлежит ни одной колонке — пропусков должно быть два',
    ).toBeGreaterThanOrEqual(2);
  });
});
