import { describe, expect, it } from 'vitest';

import {
  engineInternalNumberDuplicateMessage,
  engineInternalNumberKey,
  engineInternalNumberSortKey,
  formatEngineInternalNumber,
  isValidEngineInternalNumberYear,
  matchesEngineInternalNumber,
  normalizeEngineInternalNumber,
  parseEngineInternalNumberInput,
  resolveEngineInternalNumberYear,
} from './engineInternalNumber.js';

describe('normalizeEngineInternalNumber', () => {
  it('срезает ведущие нули у числовых номеров: 041 и 41 — один номер журнала', () => {
    expect(normalizeEngineInternalNumber('041')).toBe('41');
    expect(normalizeEngineInternalNumber('41')).toBe('41');
    expect(normalizeEngineInternalNumber(' 0041 ')).toBe('41');
  });

  it('не трогает ведущие нули в буквенно-цифровых номерах', () => {
    expect(normalizeEngineInternalNumber('А-041')).toBe(normalizeEngineInternalNumber('а 041'));
    expect(normalizeEngineInternalNumber('А-041')).not.toBe('41');
  });

  it('пустой ввод даёт пустой ключ', () => {
    expect(normalizeEngineInternalNumber('')).toBe('');
    expect(normalizeEngineInternalNumber('   ')).toBe('');
  });
});

describe('engineInternalNumberKey', () => {
  it('одинаковый номер в разных годах — разные ключи (годовой сброс нумерации)', () => {
    expect(engineInternalNumberKey('41', 2026)).not.toBe(engineInternalNumberKey('41', 2027));
  });

  it('041/2026 и 41/2026 — один ключ (дубль)', () => {
    expect(engineInternalNumberKey('041', 2026)).toBe(engineInternalNumberKey('41', 2026));
  });

  it('без номера или с негодным годом ключа нет — гейт дублей молчит', () => {
    expect(engineInternalNumberKey('', 2026)).toBeNull();
    expect(engineInternalNumberKey('41', null)).toBeNull();
    expect(engineInternalNumberKey('41', 1999)).toBeNull();
    expect(engineInternalNumberKey('41', 'abc')).toBeNull();
  });
});

describe('formatEngineInternalNumber', () => {
  it('склеивает номер и две цифры года', () => {
    expect(formatEngineInternalNumber('41', 2026)).toBe('41/26');
    expect(formatEngineInternalNumber('7', 2027)).toBe('7/27');
  });

  it('год < 2010 печатается с ведущим нулём', () => {
    expect(formatEngineInternalNumber('41', 2009)).toBe('41/09');
  });

  it('без годного года показывает голый номер, без пустого хвоста', () => {
    expect(formatEngineInternalNumber('41', null)).toBe('41');
    expect(formatEngineInternalNumber('41', 1999)).toBe('41');
  });

  it('пустой номер — пустая строка', () => {
    expect(formatEngineInternalNumber('', 2026)).toBe('');
  });
});

describe('parseEngineInternalNumberInput', () => {
  it('разбирает полный номер из журнала', () => {
    expect(parseEngineInternalNumberInput('41/26')).toEqual({ number: '41', year: 2026 });
    expect(parseEngineInternalNumberInput(' 41 / 26 ')).toEqual({ number: '41', year: 2026 });
  });

  it('голый номер оставляет год на авто-подстановку', () => {
    expect(parseEngineInternalNumberInput('41')).toEqual({ number: '41', year: null });
  });

  it('буквенный номер с годом', () => {
    expect(parseEngineInternalNumberInput('А-41/26')).toEqual({ number: 'А-41', year: 2026 });
  });

  it('не считает годом то, что им быть не может', () => {
    expect(parseEngineInternalNumberInput('41/2026')).toEqual({ number: '41/2026', year: null });
  });

  it('пустой ввод', () => {
    expect(parseEngineInternalNumberInput('  ')).toEqual({ number: '', year: null });
  });
});

describe('resolveEngineInternalNumberYear', () => {
  it('подставляет текущий год — номер выдаётся из журнала сегодня', () => {
    expect(resolveEngineInternalNumberYear(new Date(2026, 6, 15).getTime())).toBe(2026);
    expect(resolveEngineInternalNumberYear(new Date(2027, 0, 3).getTime())).toBe(2027);
  });
});

describe('matchesEngineInternalNumber', () => {
  it('короткий запрос находит все «41-е» по годам', () => {
    expect(matchesEngineInternalNumber('41', '41', 2026)).toBe(true);
    expect(matchesEngineInternalNumber('41', '41', 2027)).toBe(true);
  });

  it('точный запрос отсекает чужой год', () => {
    expect(matchesEngineInternalNumber('41/26', '41', 2026)).toBe(true);
    expect(matchesEngineInternalNumber('41/26', '41', 2027)).toBe(false);
  });

  it('запрос с ведущими нулями находит тот же номер', () => {
    expect(matchesEngineInternalNumber('041', '41', 2026)).toBe(true);
  });

  it('чужой номер не совпадает', () => {
    expect(matchesEngineInternalNumber('42', '41', 2026)).toBe(false);
  });

  it('пустой запрос ничего не находит', () => {
    expect(matchesEngineInternalNumber('', '41', 2026)).toBe(false);
  });
});

describe('engineInternalNumberSortKey', () => {
  const sorted = (rows: Array<[string, number | null]>) =>
    [...rows]
      .sort((a, b) => engineInternalNumberSortKey(a[0], a[1]).localeCompare(engineInternalNumberSortKey(b[0], b[1]), 'ru'))
      .map(([n, y]) => formatEngineInternalNumber(n, y));

  it('сортирует номера как числа, а не как строки', () => {
    expect(sorted([
      ['41', 2026],
      ['7', 2026],
      ['100', 2026],
    ])).toEqual(['7/26', '41/26', '100/26']);
  });

  it('группирует по годам: год старше — раньше', () => {
    expect(sorted([
      ['7', 2027],
      ['41', 2026],
    ])).toEqual(['41/26', '7/27']);
  });

  it('строки без номера уезжают в конец', () => {
    const keys = [engineInternalNumberSortKey('', null), engineInternalNumberSortKey('41', 2026)];
    expect(keys[0]).toBe('');
    expect(keys[0]! < keys[1]!).toBe(true);
  });
});

describe('engineInternalNumberDuplicateMessage', () => {
  it('называет занявший двигатель, чтобы оператор понял, куда смотреть', () => {
    const msg = engineInternalNumberDuplicateMessage({
      internalNumber: '41',
      internalNumberYear: 2026,
      engineNumber: '12345',
      engineBrand: 'ЯМЗ-238',
    });
    expect(msg).toContain('41/26');
    expect(msg).toContain('ЯМЗ-238 12345');
  });

  it('без данных о занявшем — только номер, без пустого хвоста', () => {
    const msg = engineInternalNumberDuplicateMessage({ internalNumber: '41', internalNumberYear: 2026 });
    expect(msg).toContain('41/26');
    expect(msg).not.toContain('Его занял');
  });
});

describe('isValidEngineInternalNumberYear', () => {
  it('принимает разумный диапазон', () => {
    expect(isValidEngineInternalNumberYear(2026)).toBe(true);
    expect(isValidEngineInternalNumberYear(2000)).toBe(true);
    expect(isValidEngineInternalNumberYear(2099)).toBe(true);
  });

  it('отбивает мусор и выход за диапазон', () => {
    expect(isValidEngineInternalNumberYear(1999)).toBe(false);
    expect(isValidEngineInternalNumberYear(2100)).toBe(false);
    expect(isValidEngineInternalNumberYear(2026.5)).toBe(false);
    expect(isValidEngineInternalNumberYear(null)).toBe(false);
  });
});
