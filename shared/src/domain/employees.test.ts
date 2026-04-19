import { describe, expect, it } from 'vitest';

import {
  formatEmploymentStatusAttrForUi,
  parseEmploymentStatusAttr,
  resolveEmploymentStatusCode,
} from './employees.js';

describe('employment status', () => {
  it('maps english and russian synonyms to codes', () => {
    expect(parseEmploymentStatusAttr('working')).toBe('working');
    expect(parseEmploymentStatusAttr('WORKING')).toBe('working');
    expect(parseEmploymentStatusAttr('работает')).toBe('working');
    expect(parseEmploymentStatusAttr('Работает')).toBe('working');
    expect(parseEmploymentStatusAttr('fired')).toBe('fired');
    expect(parseEmploymentStatusAttr('уволен')).toBe('fired');
    expect(parseEmploymentStatusAttr('уволен по соглашению')).toBe('fired');
  });

  it('formats UI label always in Russian', () => {
    expect(formatEmploymentStatusAttrForUi('working')).toBe('работает');
    expect(formatEmploymentStatusAttrForUi('работает')).toBe('работает');
    expect(formatEmploymentStatusAttrForUi('fired')).toBe('уволен');
  });

  it('uses termination date as fired', () => {
    expect(resolveEmploymentStatusCode('working', Date.now())).toBe('fired');
    expect(resolveEmploymentStatusCode('working', null)).toBe('working');
  });
});
