import { describe, expect, it } from 'vitest';

import { BRAND_LABEL_TEXTS, lookupLabel } from './lookupLabel.js';

const BRANDS: Record<string, string> = {
  'a3f19b2c-1d4e-4a7b-9c8d-2e5f6a7b8c9d': 'ЯМЗ-238',
  'b1111111-2222-3333-4444-555555555555': '   ',
};

const get = (key: string) => BRANDS[key];

describe('lookupLabel', () => {
  it('отдаёт название, когда справочник знает запись', () => {
    expect(lookupLabel('a3f19b2c-1d4e-4a7b-9c8d-2e5f6a7b8c9d', get, BRAND_LABEL_TEXTS)).toBe('ЯМЗ-238');
  });

  // Ровно то, что видел оператор до этой правки: справочник не догрузился — в чипе UUID.
  it('никогда не отдаёт идентификатор, когда записи нет', () => {
    const text = lookupLabel('c0000000-0000-0000-0000-000000000009', get, BRAND_LABEL_TEXTS);
    expect(text).toBe('⚠ марка удалена');
    expect(text).not.toContain('c0000000');
  });

  it('пустое название в справочнике — тоже «не найдено», а не пустая ячейка', () => {
    expect(lookupLabel('b1111111-2222-3333-4444-555555555555', get, BRAND_LABEL_TEXTS)).toBe('⚠ марка удалена');
  });

  it('различает «связи нет» и «связь есть, записи нет»', () => {
    expect(lookupLabel('', get, BRAND_LABEL_TEXTS)).toBe('Без марки');
    expect(lookupLabel(null, get, BRAND_LABEL_TEXTS)).toBe('Без марки');
  });

  it('без своих текстов ставит прочерк, а не пустоту', () => {
    expect(lookupLabel(null, get)).toBe('—');
    expect(lookupLabel('нет-такого', get)).toBe('—');
  });

  // Справочник, который сам хранит идентификатор вместо названия, не должен его протащить.
  it('не пропускает идентификатор, пришедший из самого справочника', () => {
    const echoing = () => 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
    expect(lookupLabel('любой', echoing, BRAND_LABEL_TEXTS)).toBe('⚠ марка удалена');
  });
});
