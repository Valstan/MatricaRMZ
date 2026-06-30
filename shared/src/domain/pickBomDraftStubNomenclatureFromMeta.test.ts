import { describe, expect, it } from 'vitest';

import { pickBomDraftStubNomenclatureFromMeta } from './warehouse.js';

const BRAND_A = '11111111-1111-1111-1111-111111111111';

describe('pickBomDraftStubNomenclatureFromMeta (v1.21.3: no fallback to first)', () => {
  it('returns engine-nomenclature attached to brand by defaultBrandId', () => {
    const result = pickBomDraftStubNomenclatureFromMeta(
      [
        { id: 'nom-1', defaultBrandId: BRAND_A, itemType: 'engine' },
        { id: 'nom-2', defaultBrandId: BRAND_A, itemType: 'component' },
      ],
      BRAND_A,
    );
    expect(result).toBe('nom-1');
  });

  it('returns engine-nomenclature even if category=engine without itemType', () => {
    const result = pickBomDraftStubNomenclatureFromMeta(
      [{ id: 'nom-1', defaultBrandId: BRAND_A, category: 'engine' }],
      BRAND_A,
    );
    expect(result).toBe('nom-1');
  });

  it('returns null when brand has only non-engine nomenclature (no first-fallback anymore)', () => {
    // До v1.21.3 эта ситуация возвращала бы первую попавшуюся (например, гильзу)
    // и пустые черновые строки попадали бы со ссылкой на случайную деталь.
    const result = pickBomDraftStubNomenclatureFromMeta(
      [
        { id: 'nom-1', defaultBrandId: BRAND_A, itemType: 'component' },
        { id: 'nom-2', defaultBrandId: BRAND_A, itemType: 'component' },
      ],
      BRAND_A,
    );
    expect(result).toBeNull();
  });

  it('returns null when there is no nomenclature for the brand at all', () => {
    const result = pickBomDraftStubNomenclatureFromMeta(
      [{ id: 'nom-1', defaultBrandId: 'other-brand', itemType: 'engine' }],
      BRAND_A,
    );
    expect(result).toBeNull();
  });

  it('returns null for empty engineBrandId', () => {
    expect(
      pickBomDraftStubNomenclatureFromMeta(
        [{ id: 'nom-1', defaultBrandId: BRAND_A, itemType: 'engine' }],
        '',
      ),
    ).toBeNull();
  });

  it('returns null on empty nomenclature list', () => {
    expect(pickBomDraftStubNomenclatureFromMeta([], BRAND_A)).toBeNull();
  });
});
