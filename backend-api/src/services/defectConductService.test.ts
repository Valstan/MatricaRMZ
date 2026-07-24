import { describe, expect, it } from 'vitest';

import { buildDefectInitialEvents, normalizeDefectSerialNumber } from './defectConductService.js';

describe('defect conduct helpers', () => {
  it('normalizes a stamped number without inventing one', () => {
    expect(normalizeDefectSerialNumber('  АБ  12－3 ')).toBe('аб 12-3');
    expect(normalizeDefectSerialNumber('')).toBe('');
  });

  it('creates repairable, scrap and replacement history from conducted quantities', () => {
    expect(buildDefectInitialEvents({ repairableQty: 2, scrapQty: 1, replaceQty: 3, replenishmentMethod: 'purchase' })).toEqual([
      { type: 'classified_repairable', qty: 2 },
      { type: 'classified_scrap', qty: 1 },
      { type: 'replacement_required', qty: 3 },
      { type: 'purchase_requested', qty: 3 },
    ]);
  });

  it('does not create synthetic instance events for an unnumbered quantity', () => {
    expect(buildDefectInitialEvents({ repairableQty: 4, scrapQty: 0, replaceQty: 0 })).toEqual([
      { type: 'classified_repairable', qty: 4 },
    ]);
  });
});
