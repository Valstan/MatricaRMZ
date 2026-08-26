import { describe, expect, it } from 'vitest';

import {
  EMPTY_SUPPORT_CONTACT,
  hasSupportContact,
  sanitizeSupportContact,
} from './supportContact.js';

describe('sanitizeSupportContact', () => {
  it('берёт телефон и подпись как есть, обрезая пробелы', () => {
    expect(sanitizeSupportContact({ phone: '  8 900 000-00-00 ', person: ' Иванов И. И. ' })).toEqual({
      phone: '8 900 000-00-00',
      person: 'Иванов И. И.',
    });
  });

  it('форматом телефона не командует', () => {
    const formats = ['+7 (900) 000-00-00', '89000000000', '8-900-000-00-00', 'вн. 217'];
    for (const phone of formats) {
      expect(sanitizeSupportContact({ phone, person: '' }).phone).toBe(phone);
    }
  });

  it('схлопывает переводы строк — значение рендерится одной строкой', () => {
    expect(sanitizeSupportContact({ phone: '8 900\n000', person: 'Иванов\r\nИ. И.' })).toEqual({
      phone: '8 900 000',
      person: 'Иванов И. И.',
    });
  });

  it('режет слишком длинные значения', () => {
    const long = 'я'.repeat(500);
    const cleaned = sanitizeSupportContact({ phone: long, person: long });
    expect(cleaned.phone).toHaveLength(40);
    expect(cleaned.person).toHaveLength(120);
  });

  it('на мусоре отдаёт пустой контакт, а не падает', () => {
    for (const raw of [null, undefined, 'строка', 42, [], { nope: 1 }]) {
      expect(sanitizeSupportContact(raw)).toEqual(EMPTY_SUPPORT_CONTACT);
    }
  });
});

describe('hasSupportContact', () => {
  it('пустой контакт прячет блок', () => {
    expect(hasSupportContact(EMPTY_SUPPORT_CONTACT)).toBe(false);
    expect(hasSupportContact(null)).toBe(false);
    expect(hasSupportContact(undefined)).toBe(false);
  });

  it('хватает одного заполненного поля', () => {
    expect(hasSupportContact({ phone: '8 900 000-00-00', person: '' })).toBe(true);
    expect(hasSupportContact({ phone: '', person: 'Иванов И. И.' })).toBe(true);
  });
});
