import { describe, expect, it } from 'vitest';

import { isSyntheticNomenclatureCode } from './nomenclatureCode.js';

describe('isSyntheticNomenclatureCode', () => {
  it('ловит ОБЕ генерируемые формы — на легаси-форме маска однажды промолчала (M41)', () => {
    // Текущая: PREFIX + 8 цифр времени + 3 случайные.
    expect(isSyntheticNomenclatureCode('DET-17532198765')).toBe(true);
    // Легаси: PREFIX + 8 hex. 141 из 145 прод-строк были именно такими.
    expect(isSyntheticNomenclatureCode('DET-0553FEE9')).toBe(true);
    expect(isSyntheticNomenclatureCode('NM-93151614')).toBe(true);
  });

  it('знает все префиксы, которые штамповало приложение, а не только DET/NM', () => {
    for (const prefix of ['TLS', 'PRD', 'SRV', 'ASM', 'ENG', 'CMP', 'MAT', 'CNS']) {
      expect(isSyntheticNomenclatureCode(`${prefix}-0553FEE9`)).toBe(true);
    }
  });

  it('не трогает живые вендорские артикулы', () => {
    expect(isSyntheticNomenclatureCode('SRV-001')).toBe(false); // услуги на проде
    expect(isSyntheticNomenclatureCode('NM-1050')).toBe(false);
    expect(isSyntheticNomenclatureCode('3301-15-30')).toBe(false); // картер
    expect(isSyntheticNomenclatureCode('303-07-22')).toBe(false);
    expect(isSyntheticNomenclatureCode('')).toBe(false);
    expect(isSyntheticNomenclatureCode(null)).toBe(false);
  });

  it('нормализует регистр и пробелы — иначе стоп-кран обходится вводом строчными', () => {
    expect(isSyntheticNomenclatureCode('  det-0553fee9  ')).toBe(true);
  });

  it('не срабатывает на чужой длине — 7 и 9 hex это уже не наша форма', () => {
    expect(isSyntheticNomenclatureCode('DET-0553FEE')).toBe(false);
    expect(isSyntheticNomenclatureCode('DET-0553FEE99')).toBe(false);
  });
});
