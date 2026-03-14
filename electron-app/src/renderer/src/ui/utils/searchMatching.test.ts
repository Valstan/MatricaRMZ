import { describe, expect, it } from 'vitest';

import { buildLookupHighlightParts, rankLookupOptions } from './searchMatching.js';

describe('searchMatching', () => {
  it('finds options by secondary search fields', () => {
    const options = [
      { id: 'contract-1', label: 'Контракт А', hintText: 'Внутр. 17', searchText: 'Внутренний 17 ООО Ромашка' },
      { id: 'contract-2', label: 'Контракт Б', hintText: 'Внутр. 42', searchText: 'Внутренний 42 АО Вектор' },
    ];

    const result = rankLookupOptions(options, 'вектор 42');

    expect(result[0]?.id).toBe('contract-2');
  });

  it('highlights matching fragments in helper text', () => {
    const parts = buildLookupHighlightParts('ИНН 7701234567', '7701');

    expect(parts.some((part) => part.matched && part.text === '7701')).toBe(true);
  });
});
