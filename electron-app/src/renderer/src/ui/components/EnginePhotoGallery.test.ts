import { describe, expect, it } from 'vitest';

import { stepGalleryIndex } from './EnginePhotoGallery.js';

describe('stepGalleryIndex', () => {
  it('moves in both directions and wraps at the ends', () => {
    expect(stepGalleryIndex(1, 1, 3)).toBe(2);
    expect(stepGalleryIndex(1, -1, 3)).toBe(0);
    expect(stepGalleryIndex(2, 1, 3)).toBe(0);
    expect(stepGalleryIndex(0, -1, 3)).toBe(2);
  });
});
