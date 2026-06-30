import { describe, expect, it } from 'vitest';

import { buildPartIdToNomenclatureMap } from '../services/workOrderClosingService.js';

// G1 (parts-chain-audit): a work-line partId must resolve to a real erp_nomenclature.id
// before it lands on a warehouse document line. Resolution rule: id-match wins, else the
// directory_ref bridge (bom-parts backfill), else passthrough unchanged.
describe('buildPartIdToNomenclatureMap', () => {
  it('keeps an id that is already a valid nomenclature (id-equality, the 102 case)', () => {
    const map = buildPartIdToNomenclatureMap(['n1'], new Set(['n1']), new Map());
    expect(map.get('n1')).toBe('n1');
  });

  it('remaps a directory_parts.id to its bridging nomenclature (the 27 bom-parts case)', () => {
    const map = buildPartIdToNomenclatureMap(['dp1'], new Set(['nomA']), new Map([['dp1', 'nomA']]));
    expect(map.get('dp1')).toBe('nomA');
  });

  it('prefers id-match over the directory_ref bridge when both exist', () => {
    // id is itself a nomenclature AND a ref target — id-equality must win.
    const map = buildPartIdToNomenclatureMap(['x'], new Set(['x']), new Map([['x', 'other']]));
    expect(map.get('x')).toBe('x');
  });

  it('passes an unknown id through unchanged (no nomenclature, no bridge)', () => {
    const map = buildPartIdToNomenclatureMap(['ghost'], new Set(['n1']), new Map());
    expect(map.get('ghost')).toBe('ghost');
  });

  it('handles a mixed batch and skips empty ids', () => {
    const map = buildPartIdToNomenclatureMap(
      ['n1', 'dp1', 'ghost', ''],
      new Set(['n1', 'nomA']),
      new Map([['dp1', 'nomA']]),
    );
    expect(map.get('n1')).toBe('n1');
    expect(map.get('dp1')).toBe('nomA');
    expect(map.get('ghost')).toBe('ghost');
    expect(map.has('')).toBe(false);
  });
});
