import { describe, expect, it } from 'vitest';

import { buildFavoriteShortcut, parseFavoriteShortcut } from './favoriteShortcut.js';

describe('favorite shortcuts', () => {
  it('round-trips a card title and deep link', () => {
    const shortcut = buildFavoriteShortcut('engine', 'engine-1', 'Двигатель 18ДМ.001');
    expect(shortcut).not.toBeNull();
    expect(parseFavoriteShortcut(shortcut!)).toEqual({
      title: 'Двигатель 18ДМ.001',
      link: {
        kind: 'app_link',
        tab: 'engine',
        cardKind: 'engine',
        entityId: 'engine-1',
        breadcrumbs: ['Двигатель 18ДМ.001'],
      },
    });
  });

  it('rejects unsupported card kinds and malformed values', () => {
    expect(buildFavoriteShortcut('', '1', 'Unknown')).toBeNull();
    expect(parseFavoriteShortcut('favorite:not-json')).toBeNull();
  });
});
