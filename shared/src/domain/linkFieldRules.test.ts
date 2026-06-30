import { describe, expect, it } from 'vitest';

import { buildLinkTypeOptions, suggestLinkTargetCode, suggestLinkTargetCodeWithRules } from './linkFieldRules.js';

describe('linkFieldRules', () => {
  it('suggests target type by name', () => {
    expect(suggestLinkTargetCode('Отдел')).toBe('department');
    expect(suggestLinkTargetCode('Двигатель')).toBe('engine');
    expect(suggestLinkTargetCode('Поставщик')).toBe('customer');
  });

  it('prefers explicit rules when provided', () => {
    const rules = [
      { fieldName: 'Клиент', targetTypeCode: 'customer', priority: 5 },
      { fieldName: 'Контракт', targetTypeCode: 'contract', priority: 1 },
    ];
    expect(suggestLinkTargetCodeWithRules('Клиент', rules)).toBe('customer');
  });

  it('builds ordered link type options', () => {
    const types = [{ code: 'a' }, { code: 'b' }, { code: 'c' }];
    const options = buildLinkTypeOptions(types, 'b', 'c');
    expect(options[0].type.code).toBe('b');
    expect(options[1].type.code).toBe('c');
  });
});
