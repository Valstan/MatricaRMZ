import { describe, expect, it } from 'vitest';

import {
  insertKeyByTarget,
  remapBlockKeys,
  renumberRows,
  reorderRows,
  rowKeyAt,
} from './listReorder.js';

const rows = ['А', 'Б', 'В', 'Г'];

describe('мост «новый порядок → массив строк»', () => {
  it('строки встают в новый порядок', () => {
    expect(reorderRows(rows, ['2', '0', '3', '1'])).toEqual(['В', 'А', 'Г', 'Б']);
  });

  it('частичный порядок — названные строки вперёд, остальные сохраняют порядок', () => {
    expect(reorderRows(rows, ['3'])).toEqual(['Г', 'А', 'Б', 'В']);
  });

  it('строка, о которой порядок не сказал, не теряется молча', () => {
    const next = reorderRows(rows, ['1']);
    expect(next).toHaveLength(rows.length);
    expect(next).toEqual(['Б', 'А', 'В', 'Г']);
  });

  it('пустой список — пустой результат', () => {
    expect(reorderRows([], ['0'])).toEqual([]);
  });

  it('чужой номер в порядке игнорируется, а не роняет список', () => {
    expect(reorderRows(rows, ['zzz', '1'])).toEqual(['Б', 'А', 'В', 'Г']);
  });

  it('повтор номера в порядке не дублирует строку', () => {
    expect(reorderRows(rows, ['1', '1', '0'])).toEqual(['Б', 'А', 'В', 'Г']);
  });
});

describe('место вставки при перетаскивании', () => {
  it('строка встаёт перед строкой-целью', () => {
    expect(insertKeyByTarget(['0', '1', '2'], '0', '2', 'before')).toEqual(['1', '0', '2']);
  });

  it('строка встаёт после строки-цели', () => {
    expect(insertKeyByTarget(['0', '1', '2'], '0', '1', 'after')).toEqual(['1', '0', '2']);
  });

  it('перетаскивание вверх по списку', () => {
    expect(insertKeyByTarget(['0', '1', '2'], '2', '0', 'before')).toEqual(['2', '0', '1']);
  });

  it('строка, отпущенная на самой себе, не меняет порядок', () => {
    expect(insertKeyByTarget(['0', '1', '2'], '1', '1', 'before')).toEqual(['0', '1', '2']);
  });

  it('неизвестная цель — строка уходит в конец, а не пропадает', () => {
    expect(insertKeyByTarget(['0', '1', '2'], '0', 'zzz', 'before')).toEqual(['1', '2', '0']);
  });

  it('неизвестная перетаскиваемая строка — порядок не меняется', () => {
    expect(insertKeyByTarget(['0', '1', '2'], 'zzz', '0', 'before')).toEqual(['0', '1', '2']);
  });
});

describe('пересчёт номеров перемещаемого блока', () => {
  it('после сдвига блок помнит, где теперь его строки', () => {
    // Строка «1» переехала на последнее место — её новый номер «2».
    expect(remapBlockKeys(['1'], ['0', '2', '1'])).toEqual(['2']);
  });

  it('блок из нескольких строк пересчитывается целиком', () => {
    expect(remapBlockKeys(['0', '2'], ['2', '0', '1'])).toEqual(['1', '0']);
  });

  it('строка, выпавшая из порядка, сохраняет прежний номер', () => {
    expect(remapBlockKeys(['9'], ['0', '1'])).toEqual(['9']);
  });
});

describe('нумерация строк', () => {
  it('номер строки следует за её местом', () => {
    const numbered = renumberRows([
      { lineNo: 1, id: 'x' },
      { lineNo: 2, id: 'y' },
      { lineNo: 3, id: 'z' },
    ]);
    expect(numbered.map((r) => r.lineNo)).toEqual([1, 2, 3]);
  });

  it('после перестановки номера идут подряд', () => {
    const reordered = reorderRows(
      [
        { lineNo: 1, id: 'x' },
        { lineNo: 2, id: 'y' },
        { lineNo: 3, id: 'z' },
      ],
      ['2', '0', '1'],
    );
    expect(renumberRows(reordered).map((r) => `${r.id}:${r.lineNo}`)).toEqual(['z:1', 'x:2', 'y:3']);
  });
});

describe('номер строки', () => {
  it('номер строки — её позиция, и он же ключ кита', () => {
    expect(rowKeyAt(0)).toBe('0');
    expect(rowKeyAt(7)).toBe('7');
  });
});
