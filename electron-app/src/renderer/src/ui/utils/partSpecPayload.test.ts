import { describe, expect, it } from 'vitest';

import { buildPartSpecPayload } from './partSpecPayload.js';

describe('buildPartSpecPayload', () => {
  it('round-trips code untouched (Phase 3.5 — templateId axis removed)', () => {
    const out = buildPartSpecPayload({ code: 'ART-1', dimensions: [], brandLinks: [] });
    expect(out.code).toBe('ART-1');
    expect(out).toEqual({ code: 'ART-1', dimensions: [], brandLinks: [] });
  });

  it('normalizes code null', () => {
    const out = buildPartSpecPayload({ code: null, dimensions: [], brandLinks: [] });
    expect(out.code).toBeNull();
  });

  it('trims dimension name/value and drops fully-empty rows', () => {
    const out = buildPartSpecPayload({
      code: null,
      dimensions: [
        { id: 'd1', name: '  L  ', value: ' 10 ' },
        { id: 'd2', name: '   ', value: '   ' },
        { id: 'd3', name: 'D', value: '' },
      ],
      brandLinks: [],
    });
    expect(out.dimensions).toEqual([
      { id: 'd1', name: 'L', value: '10' },
      { id: 'd3', name: 'D', value: '' },
    ]);
  });

  it('drops brand-links without engineBrandId and trims assemblyUnitNumber to null when empty', () => {
    const out = buildPartSpecPayload({
      code: null,
      dimensions: [],
      brandLinks: [
        { id: 'b1', engineBrandId: 'eb1', assemblyUnitNumber: '  U1  ', quantity: 3 },
        { id: 'b2', engineBrandId: null, assemblyUnitNumber: 'U2', quantity: 1 },
        { id: 'b3', engineBrandId: 'eb3', assemblyUnitNumber: '   ', quantity: 2 },
      ],
    });
    expect(out.brandLinks).toEqual([
      { id: 'b1', engineBrandId: 'eb1', assemblyUnitNumber: 'U1', quantity: 3 },
      { id: 'b3', engineBrandId: 'eb3', assemblyUnitNumber: null, quantity: 2 },
    ]);
  });

  it('coerces non-finite quantity to 0', () => {
    const out = buildPartSpecPayload({
      code: null,
      dimensions: [],
      brandLinks: [{ id: 'b1', engineBrandId: 'eb1', assemblyUnitNumber: null, quantity: Number.NaN }],
    });
    expect(out.brandLinks[0]!.quantity).toBe(0);
  });
});
