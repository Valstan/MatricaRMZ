import { describe, expect, it } from 'vitest';

import { assembleGlobalSearch } from '../services/globalSearchService.js';

describe('assembleGlobalSearch', () => {
  it('maps nomenclature and stock-document rows to unified hits', () => {
    const res = assembleGlobalSearch('porsh', {
      nomenclature: [{ id: 'n1', code: '3301-15-30', name: 'Поршень' }],
      stockDocuments: [{ id: 'd1', docNo: 'РЗ-2026-001', docType: 'repair_recovery' }],
    });
    expect(res.query).toBe('porsh');
    expect(res.truncated).toBe(false);
    expect(res.hits).toEqual([
      { kind: 'nomenclature', id: 'n1', label: 'Поршень', code: '3301-15-30' },
      { kind: 'stock_document', id: 'd1', label: 'РЗ-2026-001', code: 'РЗ-2026-001' },
    ]);
  });

  it('omits a kind whose source was not provided (permission-gated upstream)', () => {
    const res = assembleGlobalSearch('x', {
      stockDocuments: [{ id: 'd1', docNo: 'РЗ-1' }],
    });
    expect(res.hits.every((h) => h.kind === 'stock_document')).toBe(true);
    expect(res.hits).toHaveLength(1);
  });

  it('returns an empty result for a blank query', () => {
    const res = assembleGlobalSearch('   ', { nomenclature: [{ id: 'n1', name: 'x' }] });
    expect(res).toEqual({ query: '', hits: [], truncated: false });
  });

  it('drops rows without an id and falls back label to code then id', () => {
    const res = assembleGlobalSearch('q', {
      nomenclature: [
        { code: 'C1', name: 'no id' },
        { id: 'n2', code: 'C2' },
        { id: 'n3' },
      ],
    });
    expect(res.hits).toEqual([
      { kind: 'nomenclature', id: 'n2', label: 'C2', code: 'C2' },
      { kind: 'nomenclature', id: 'n3', label: 'n3' },
    ]);
  });

  it('caps total hits and flags truncated', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, name: `name ${i}` }));
    const res = assembleGlobalSearch('q', { nomenclature: many }, { perKindLimit: 50, totalCap: 10 });
    expect(res.hits).toHaveLength(10);
    expect(res.truncated).toBe(true);
  });
});
