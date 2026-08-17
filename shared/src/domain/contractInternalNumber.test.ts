import { describe, expect, it } from 'vitest';

import {
  contractInternalNumberDuplicateMessage,
  contractInternalNumberKey,
} from './contractInternalNumber.js';

describe('contractInternalNumberKey', () => {
  it('считает один и тот же номер, набранный по-разному, одним номером', () => {
    const canonical = contractInternalNumberKey('20/ГОЗ-25');
    expect(contractInternalNumberKey('20/гоз-25')).toBe(canonical);
    expect(contractInternalNumberKey('20 ГОЗ 25')).toBe(canonical);
    expect(contractInternalNumberKey('  20 / ГОЗ - 25  ')).toBe(canonical);
    // «ё» → «е» тем же нормализатором, что и поиск: гейт и поиск не должны
    // расходиться в понимании «это одно и то же».
    expect(contractInternalNumberKey('20/ГOЗ-25'.replace('O', 'О'))).toBe(canonical);
  });

  it('различает разные номера', () => {
    expect(contractInternalNumberKey('20/ГОЗ-25')).not.toBe(contractInternalNumberKey('21/ГОЗ-25'));
    // Год — часть строки, а не отдельный атрибут: 20-й договор ГОЗ-25 и
    // ГОЗ-26 — разные договоры (в отличие от внутреннего номера двигателя,
    // где год живёт вторым атрибутом пары).
    expect(contractInternalNumberKey('20/ГОЗ-25')).not.toBe(contractInternalNumberKey('20/ГОЗ-26'));
  });

  it('пустое значение — не номер: второе незаполненное поле запрещать нельзя', () => {
    expect(contractInternalNumberKey('')).toBe('');
    expect(contractInternalNumberKey('   ')).toBe('');
    expect(contractInternalNumberKey(null)).toBe('');
    expect(contractInternalNumberKey(undefined)).toBe('');
    // Строка из одних разделителей тоже пуста после нормализации — иначе гейт
    // отбивал бы «/» об «-» как «номер уже занят».
    expect(contractInternalNumberKey('/-/')).toBe('');
  });
});

describe('contractInternalNumberDuplicateMessage', () => {
  it('называет занявший договор, чтобы владелец понял, тот же это договор или другой', () => {
    const msg = contractInternalNumberDuplicateMessage({
      id: 'a16948e4',
      internalNumber: '20/ГОЗ-25',
      contractNumber: '2527187908521442245215425/641/25',
    });
    expect(msg).toContain('«20/ГОЗ-25»');
    expect(msg).toContain('2527187908521442245215425/641/25');
  });

  it('без казённого номера не оставляет висящего «занял договор №»', () => {
    const msg = contractInternalNumberDuplicateMessage({ id: 'x', internalNumber: '21/ГОЗ-25' });
    expect(msg).toContain('«21/ГОЗ-25»');
    expect(msg).not.toContain('№');
  });
});
