import { describe, expect, it } from 'vitest';

import { countListedPartsByBrand } from './engineBrandSummary.js';

describe('countListedPartsByBrand', () => {
  it('counts nomenclature positions without summing their physical quantity', () => {
    expect(
      countListedPartsByBrand([
        { id: 'injector', brandLinks: [{ engineBrandId: 'brand-a', quantity: 12 }] },
        { id: 'stud', brandLinks: [{ engineBrandId: 'brand-a', quantity: 100 }] },
      ]),
    ).toEqual({ 'brand-a': 2 });
  });

  it('counts each nomenclature position only once per brand', () => {
    expect(
      countListedPartsByBrand([
        {
          id: 'injector',
          brandLinks: [
            { engineBrandId: 'brand-a', quantity: 6 },
            { engineBrandId: 'brand-a', quantity: 12 },
            { engineBrandId: 'brand-b', quantity: 8 },
          ],
        },
      ]),
    ).toEqual({ 'brand-a': 1, 'brand-b': 1 });
  });
});
