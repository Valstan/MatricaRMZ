import { describe, expect, it } from 'vitest';

import { isSupplyRequestPayloadEmpty } from './supplyRequest.js';

describe('isSupplyRequestPayloadEmpty', () => {
  it('treats a freshly-created request (no items/title/attachments) as empty', () => {
    expect(isSupplyRequestPayloadEmpty({ items: [], title: '' })).toBe(true);
    expect(isSupplyRequestPayloadEmpty({ items: [], title: '   ' })).toBe(true);
    expect(isSupplyRequestPayloadEmpty(null)).toBe(true);
    expect(isSupplyRequestPayloadEmpty(undefined)).toBe(true);
    expect(isSupplyRequestPayloadEmpty({})).toBe(true);
  });

  it('treats any content (item, title, attachment) as non-empty', () => {
    expect(isSupplyRequestPayloadEmpty({ items: [{ id: 'i1' }], title: '' })).toBe(false);
    expect(isSupplyRequestPayloadEmpty({ items: [], title: 'Срочная заявка' })).toBe(false);
    expect(isSupplyRequestPayloadEmpty({ items: [], title: '', attachments: [{ id: 'f1' }] })).toBe(false);
  });
});
