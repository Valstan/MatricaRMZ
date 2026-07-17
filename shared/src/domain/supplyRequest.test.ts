import { describe, expect, it } from 'vitest';

import { buildSupplyIncomingFromRequestPayloads, isSupplyRequestPayloadEmpty } from './supplyRequest.js';

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

describe('buildSupplyIncomingFromRequestPayloads', () => {
  const base = {
    kind: 'supply_request',
    status: 'accepted',
    expectedDeliveryAt: 1_800_000_000_000,
    items: [{ productId: 'nom-1', qty: 10 }],
  };

  it('emits ordered/delivered for accepted requests with expected delivery date', () => {
    expect(buildSupplyIncomingFromRequestPayloads([base])).toEqual([
      { productId: 'nom-1', orderedQty: 10, deliveredQty: 0, expectedAt: 1_800_000_000_000 },
    ]);
  });

  it('sums deliveries per item and keeps fully delivered items (for receipt dedup)', () => {
    const p = {
      ...base,
      status: 'fulfilled_partial',
      items: [
        { productId: 'nom-1', qty: 10, deliveries: [{ qty: 4 }, { qty: 2 }] },
        { productId: 'nom-2', qty: 5, deliveries: [{ qty: 5 }] },
      ],
    };
    expect(buildSupplyIncomingFromRequestPayloads([p])).toEqual([
      { productId: 'nom-1', orderedQty: 10, deliveredQty: 6, expectedAt: 1_800_000_000_000 },
      { productId: 'nom-2', orderedQty: 5, deliveredQty: 5, expectedAt: 1_800_000_000_000 },
    ]);
  });

  it('skips requests without expected date, wrong status, or items without productId', () => {
    expect(buildSupplyIncomingFromRequestPayloads([{ ...base, expectedDeliveryAt: null }])).toEqual([]);
    expect(buildSupplyIncomingFromRequestPayloads([{ ...base, status: 'draft' }])).toEqual([]);
    expect(buildSupplyIncomingFromRequestPayloads([{ ...base, status: 'fulfilled_full' }])).toEqual([]);
    expect(buildSupplyIncomingFromRequestPayloads([{ ...base, items: [{ qty: 3 }] }])).toEqual([]);
    expect(buildSupplyIncomingFromRequestPayloads([null, 'x', { kind: 'work_order' }])).toEqual([]);
  });
});
