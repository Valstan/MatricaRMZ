import { describe, expect, it } from 'vitest';

import {
  hasPrintColumnMismatch,
  printColumnIdsWithMissing,
  printColumnIdsWithoutExtra,
  printColumnMismatch,
} from './printColumnMismatch.js';

const COLUMNS = [
  { id: 'engineNumber', label: 'Номер' },
  { id: 'brand', label: 'Марка' },
  { id: 'customer', label: 'Контрагент' },
  { id: 'stage', label: 'Этап' },
];

describe('расхождение колонок списка и печати', () => {
  it('одинаковые наборы — расхождения нет', () => {
    const mismatch = printColumnMismatch({
      columns: COLUMNS,
      printColumnIds: ['engineNumber', 'brand'],
      visibleColumnIds: ['engineNumber', 'brand'],
    });
    expect(hasPrintColumnMismatch(mismatch)).toBe(false);
    expect(mismatch.missing).toEqual([]);
    expect(mismatch.extra).toEqual([]);
  });

  it('колонка из списка, которой нет в печати, — «недостающая»', () => {
    const mismatch = printColumnMismatch({
      columns: COLUMNS,
      printColumnIds: ['engineNumber'],
      visibleColumnIds: ['engineNumber', 'brand', 'stage'],
    });
    expect(mismatch.missing.map((c) => c.label)).toEqual(['Марка', 'Этап']);
    expect(mismatch.extra).toEqual([]);
  });

  it('колонка из печати, которой нет в списке, — «лишняя»', () => {
    const mismatch = printColumnMismatch({
      columns: COLUMNS,
      printColumnIds: ['engineNumber', 'customer'],
      visibleColumnIds: ['engineNumber', 'brand'],
    });
    expect(mismatch.extra.map((c) => c.label)).toEqual(['Контрагент']);
    expect(mismatch.missing.map((c) => c.label)).toEqual(['Марка']);
  });

  it('включение недостающих не трогает лишние и не дублирует', () => {
    const next = printColumnIdsWithMissing(['engineNumber', 'customer'], [{ id: 'brand' }, { id: 'stage' }]);
    expect(next).toEqual(['engineNumber', 'customer', 'brand', 'stage']);
    expect(printColumnIdsWithMissing(['engineNumber'], [])).toEqual(['engineNumber']);
  });

  it('отключение лишних сохраняет порядок остальных', () => {
    const next = printColumnIdsWithoutExtra(['engineNumber', 'customer', 'stage'], [{ id: 'customer' }]);
    expect(next).toEqual(['engineNumber', 'stage']);
    expect(printColumnIdsWithoutExtra(['engineNumber'], [])).toEqual(['engineNumber']);
  });

  it('обе операции вместе дают набор, равный видимому', () => {
    const mismatch = printColumnMismatch({
      columns: COLUMNS,
      printColumnIds: ['engineNumber', 'customer'],
      visibleColumnIds: ['engineNumber', 'brand'],
    });
    const withoutExtra = printColumnIdsWithoutExtra(['engineNumber', 'customer'], mismatch.extra);
    const withMissing = printColumnIdsWithMissing(withoutExtra, mismatch.missing);
    expect([...withMissing].sort()).toEqual(['brand', 'engineNumber']);
  });
});
