import { describe, expect, it, vi } from 'vitest';

import {
  erpRegStockBalance,
  erpRegStockMovements,
  erpEngineInstances,
  erpNomenclature,
} from '../database/schema.js';

/**
 * Focused verification for the warehouse code<->uuid filter fix.
 *
 * A normal (non-system) warehouse has code 'workshop_1' != uuid 'wl-uuid-workshop-1'.
 * Balances/movements/engine-instances are stored at the uuid. We filter by the CODE
 * (what the picker emits) and assert rows come back and that the emitted warehouseId is
 * the CODE. Before the fix the filter compared a uuid (row) against a code (option) -> 0 rows.
 *
 * Mocks follow the project's existing warehouse service tests: the db is a chainable builder
 * with a `then`, and warehouseLocationsService is mocked via the path the SERVICE imports it
 * by (`../services/warehouseLocationsService.js`), not the path relative to this test file.
 */
const WL = {
  default: { id: 'wl-uuid-default', code: 'default', name: 'Основной склад' },
  workshop1: { id: 'wl-uuid-workshop-1', code: 'workshop_1', name: 'Цех №1' },
};

const NOM = { id: 'nom-1', code: 'P-001', name: 'Деталь A', minStock: null };

const STOCK_ROWS = [
  { id: 'b1', nomenclatureId: NOM.id, partCardId: null, warehouseLocationId: WL.workshop1.id, qty: 7, reservedQty: 2, updatedAt: 1 },
  { id: 'b2', nomenclatureId: NOM.id, partCardId: null, warehouseLocationId: WL.default.id, qty: 3, reservedQty: 0, updatedAt: 1 },
];

const MOVE_ROWS = [
  { id: 'm1', nomenclatureId: NOM.id, warehouseLocationId: WL.workshop1.id, documentHeaderId: null, counterpartyId: null, reason: null, qtyDelta: 7, performedAt: 100 },
];

const ENGINE_ROWS = [
  { id: 'e1', nomenclatureId: NOM.id, contractId: null, contractSectionNumber: null, warehouseLocationId: WL.workshop1.id, currentStatus: 'in_stock', serialNumber: 'SN-1', createdAt: 1 },
  { id: 'e2', nomenclatureId: NOM.id, contractId: null, contractSectionNumber: null, warehouseLocationId: WL.default.id, currentStatus: 'in_stock', serialNumber: 'SN-2', createdAt: 1 },
];

vi.mock('../database/db.js', () => {
  const makeBuilder = (rowsForTable: (table: unknown) => any[]) => {
    let table: unknown;
    const builder: any = {
      from: (t: unknown) => {
        table = t;
        return builder;
      },
      where: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      then: (resolve: (rows: any[]) => unknown) => Promise.resolve(rowsForTable(table)).then(resolve),
    };
    return builder;
  };
  const rowsForTable = (table: unknown): any[] => {
    if (table === erpRegStockBalance) return [...STOCK_ROWS];
    if (table === erpRegStockMovements) return [...MOVE_ROWS];
    if (table === erpEngineInstances) return [...ENGINE_ROWS];
    if (table === erpNomenclature) return [NOM];
    return [];
  };
  return { db: { select: () => makeBuilder(rowsForTable) } };
});

vi.mock('../services/warehouseLocationsService.js', () => ({
  listWarehouseLocations: vi.fn(async () => ({
    ok: true,
    rows: [
      { id: WL.default.id, type: 'system', code: WL.default.code, name: WL.default.name, workshopId: null, isActive: true, sortOrder: 10, metadataJson: null, createdAt: 1, updatedAt: 1 },
      { id: WL.workshop1.id, type: 'workshop', code: WL.workshop1.code, name: WL.workshop1.name, workshopId: 'ws1', isActive: true, sortOrder: 20, metadataJson: null, createdAt: 1, updatedAt: 1 },
    ],
  })),
  resolveWarehouseLocationIdByCode: vi.fn(),
  resolveWarehouseLocationIdsByCodes: vi.fn(async () => new Map()),
  WAREHOUSE_LOCATION_DEFAULT_UUID: WL.default.id,
}));

const { listWarehouseStock, listWarehouseMovements, listWarehouseEngineInstances } = await import('../services/warehouseService.js');

describe('warehouse stock/movements/engine-instances filter by CODE (code<->uuid fix)', () => {
  it('listWarehouseStock returns rows when filtering by a normal warehouse CODE', async () => {
    const res = await listWarehouseStock({ warehouseId: 'workshop_1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(1);
    expect((res.rows[0] as any).id).toBe('b1');
    expect((res.rows[0] as any).warehouseId).toBe('workshop_1');
    expect((res.rows[0] as any).warehouseName).toBe('Цех №1');
  });

  it('listWarehouseStock tolerates an already-resolved uuid filter', async () => {
    const res = await listWarehouseStock({ warehouseId: 'wl-uuid-workshop-1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(1);
    expect((res.rows[0] as any).warehouseId).toBe('workshop_1');
  });

  it('listWarehouseStock filtering by a different CODE returns only that warehouse', async () => {
    const res = await listWarehouseStock({ warehouseId: 'default' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(1);
    expect((res.rows[0] as any).id).toBe('b2');
    expect((res.rows[0] as any).warehouseId).toBe('default');
  });

  it('listWarehouseStock with no filter returns all rows with code-based warehouseId', async () => {
    const res = await listWarehouseStock({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(2);
    const codes = res.rows.map((r) => (r as any).warehouseId).sort();
    expect(codes).toEqual(['default', 'workshop_1']);
  });

  it('listWarehouseMovements resolves a CODE filter to the stored uuid', async () => {
    const res = await listWarehouseMovements({ warehouseId: 'workshop_1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(1);
    expect((res.rows[0] as any).warehouseId).toBe('workshop_1');
    expect((res.rows[0] as any).warehouseName).toBe('Цех №1');
  });

  it('listWarehouseMovements with a non-matching CODE returns 0 rows', async () => {
    const res = await listWarehouseMovements({ warehouseId: 'default' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(0);
  });

  it('listWarehouseEngineInstances resolves a CODE filter to the stored uuid', async () => {
    const res = await listWarehouseEngineInstances({ warehouseId: 'workshop_1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(1);
    expect((res.rows[0] as any).id).toBe('e1');
    expect((res.rows[0] as any).warehouseId).toBe('workshop_1');
    expect((res.rows[0] as any).warehouseName).toBe('Цех №1');
  });

  it('listWarehouseEngineInstances with no filter returns all rows with code-based warehouseId', async () => {
    const res = await listWarehouseEngineInstances({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.length).toBe(2);
    const codes = res.rows.map((r) => (r as any).warehouseId).sort();
    expect(codes).toEqual(['default', 'workshop_1']);
  });
});
