import { describe, expect, it } from 'vitest';

import { sanitizeSectionFavoriteIds, toggleSectionFavoriteId } from './sectionFavorites.js';

describe('sectionFavorites utils', () => {
  it('тумблер добавляет и убирает раздел', () => {
    expect(toggleSectionFavoriteId([], 'engines')).toEqual(['engines']);
    expect(toggleSectionFavoriteId(['engines', 'work_sheets'], 'engines')).toEqual(['work_sheets']);
  });

  it('санитайзер пропускает только известные разделы без дублей', () => {
    expect(sanitizeSectionFavoriteIds(['engines', 'zzz', 'engines', 7, null])).toEqual(['engines']);
    expect(sanitizeSectionFavoriteIds(undefined)).toEqual([]);
  });
});
