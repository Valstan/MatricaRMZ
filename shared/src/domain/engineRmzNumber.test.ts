import { describe, expect, it } from 'vitest';

import {
  ENGINE_RMZ_PREFIX,
  engineRmzNumberSortKey,
  formatEngineRmzNumber,
  parseEngineRmzNumber,
} from './engineRmzNumber.js';

describe('formatEngineRmzNumber', () => {
  it('собирает номер без разделителя и без ведущих нулей', () => {
    expect(ENGINE_RMZ_PREFIX).toBe('RMZ');
    expect(formatEngineRmzNumber(1)).toBe('RMZ1');
    expect(formatEngineRmzNumber(451)).toBe('RMZ451');
    expect(formatEngineRmzNumber(2570)).toBe('RMZ2570');
  });

  it('номера нет — пустая строка (карточка ещё не доехала до сервера)', () => {
    expect(formatEngineRmzNumber(null)).toBe('');
    expect(formatEngineRmzNumber(undefined)).toBe('');
    expect(formatEngineRmzNumber(0)).toBe('');
    expect(formatEngineRmzNumber(-5)).toBe('');
    expect(formatEngineRmzNumber(Number.NaN)).toBe('');
  });
});

describe('parseEngineRmzNumber', () => {
  it('принимает канон и нижний регистр', () => {
    expect(parseEngineRmzNumber('RMZ451')).toBe(451);
    expect(parseEngineRmzNumber('  rmz451 ')).toBe(451);
    expect(parseEngineRmzNumber('RMZ1')).toBe(1);
  });

  it('голое число и чужой префикс — не номер РМЗ', () => {
    expect(parseEngineRmzNumber('451')).toBeNull();
    expect(parseEngineRmzNumber('RMZ')).toBeNull();
    expect(parseEngineRmzNumber('RMZ0')).toBeNull();
    expect(parseEngineRmzNumber('RMZ-451')).toBeNull();
    expect(parseEngineRmzNumber('41/26')).toBeNull();
    expect(parseEngineRmzNumber('')).toBeNull();
    expect(parseEngineRmzNumber(null)).toBeNull();
  });

  it('format и parse — обратные друг другу', () => {
    for (const seq of [1, 9, 10, 451, 2570]) {
      expect(parseEngineRmzNumber(formatEngineRmzNumber(seq))).toBe(seq);
    }
  });
});

describe('engineRmzNumberSortKey', () => {
  it('числовая сортировка, а не строковая', () => {
    const keys = [451, 1000, 99].map((n) => engineRmzNumberSortKey(n));
    expect([...keys].sort()).toEqual([
      engineRmzNumberSortKey(99),
      engineRmzNumberSortKey(451),
      engineRmzNumberSortKey(1000),
    ]);
  });

  it('без номера — пустой ключ, такие строки уезжают в конец', () => {
    expect(engineRmzNumberSortKey(null)).toBe('');
    expect(engineRmzNumberSortKey(0)).toBe('');
  });
});
