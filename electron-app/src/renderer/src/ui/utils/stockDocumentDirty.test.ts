import { describe, expect, it } from 'vitest';

import { buildStockDocumentSnapshot, type StockDocSnapshotLine, type StockDocSnapshotState } from './stockDocumentDirty.js';

function line(partial: Partial<StockDocSnapshotLine> = {}): StockDocSnapshotLine {
  return {
    nomenclatureId: 'nom-1',
    qty: '1',
    price: '',
    unit: 'шт',
    batch: '',
    note: '',
    warehouseId: 'default',
    fromWarehouseId: null,
    toWarehouseId: null,
    bookQty: '',
    actualQty: '',
    adjustmentQty: '',
    reason: '',
    ...partial,
  };
}

function state(partial: Partial<StockDocSnapshotState> = {}): StockDocSnapshotState {
  return {
    docNo: 'DOC-1',
    docDate: '2026-06-06',
    docType: 'stock_receipt',
    warehouseId: 'default',
    expectedDate: '',
    sourceType: 'supplier_purchase',
    sourceRef: '',
    contractId: '',
    reason: '',
    counterpartyId: null,
    lines: [line()],
    ...partial,
  };
}

describe('buildStockDocumentSnapshot', () => {
  it('is stable for identical state (no false-positive dirty)', () => {
    expect(buildStockDocumentSnapshot(state())).toBe(buildStockDocumentSnapshot(state()));
  });

  it('changes when a header field changes', () => {
    expect(buildStockDocumentSnapshot(state())).not.toBe(buildStockDocumentSnapshot(state({ docNo: 'DOC-2' })));
    expect(buildStockDocumentSnapshot(state())).not.toBe(buildStockDocumentSnapshot(state({ reason: 'правка' })));
    expect(buildStockDocumentSnapshot(state())).not.toBe(buildStockDocumentSnapshot(state({ counterpartyId: 'cp-1' })));
  });

  it('changes when a line field changes', () => {
    const base = buildStockDocumentSnapshot(state());
    expect(base).not.toBe(buildStockDocumentSnapshot(state({ lines: [line({ qty: '2' })] })));
    expect(base).not.toBe(buildStockDocumentSnapshot(state({ lines: [line({ price: '100' })] })));
    expect(base).not.toBe(buildStockDocumentSnapshot(state({ lines: [line({ nomenclatureId: 'nom-2' })] })));
  });

  it('changes when a line is added or removed', () => {
    const base = buildStockDocumentSnapshot(state());
    expect(base).not.toBe(buildStockDocumentSnapshot(state({ lines: [line(), line({ nomenclatureId: 'nom-2' })] })));
    expect(base).not.toBe(buildStockDocumentSnapshot(state({ lines: [] })));
  });

  it('changes when lines are reordered (order is significant)', () => {
    const a = state({ lines: [line({ nomenclatureId: 'nom-1' }), line({ nomenclatureId: 'nom-2' })] });
    const b = state({ lines: [line({ nomenclatureId: 'nom-2' }), line({ nomenclatureId: 'nom-1' })] });
    expect(buildStockDocumentSnapshot(a)).not.toBe(buildStockDocumentSnapshot(b));
  });

  it('treats null and undefined nullable fields identically', () => {
    const withNull = state({ warehouseId: null, counterpartyId: null });
    const withUndef = { ...state(), warehouseId: undefined as any, counterpartyId: undefined as any };
    expect(buildStockDocumentSnapshot(withNull)).toBe(buildStockDocumentSnapshot(withUndef));
  });

  it('ignores volatile non-content line fields (id/lineNo) — extra props not serialized', () => {
    const a = state({ lines: [{ ...line(), id: 'line-abc', lineNo: 1 } as any] });
    const b = state({ lines: [{ ...line(), id: 'new-9-1700000000000', lineNo: 1 } as any] });
    expect(buildStockDocumentSnapshot(a)).toBe(buildStockDocumentSnapshot(b));
  });
});
