import { describe, expect, it } from 'vitest';

import { FALLBACK_FACET_TONE, facetTones } from './facetTone.js';

describe('цвет ступени фильтра', () => {
  it('оттенок берётся от id ступени и не зависит от порядка ряда', () => {
    const a = facetTones(['customer', 'contract', 'brand']);
    const b = facetTones(['brand', 'customer', 'contract']);
    expect(a.customer?.hue).toBe(b.customer?.hue);
    expect(a.brand?.hue).toBe(b.brand?.hue);
  });

  it('внутри списка оттенки разные, пока хватает палитры', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `facet_${i}`);
    const tones = facetTones(ids);
    expect(new Set(ids.map((id) => tones[id]?.hue)).size).toBe(12);
  });

  it('все оттенки дают полосу, заливку и подложку', () => {
    const tone = facetTones(['customer']).customer ?? FALLBACK_FACET_TONE;
    expect(tone.accent).toMatch(/^hsl\(/);
    expect(tone.tint).toMatch(/^hsl\(/);
    expect(tone.panel).toMatch(/^hsl\(/);
  });
});
