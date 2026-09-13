import { describe, expect, it } from 'vitest';
import type { WarehouseNomenclatureListItem, WarehouseStockListItem } from '@matricarmz/shared';

import { collapseNomenclatureVariants, rollupStockByParent } from './nomenclatureParent.js';

function stock(p: Partial<WarehouseStockListItem> & { id: string }): WarehouseStockListItem {
  return {
    warehouseId: 'wh1',
    nomenclatureId: p.id,
    qty: 0,
    reservedQty: 0,
    availableQty: 0,
    warehouseName: 'Склад',
    nomenclatureCode: 'A-1',
    nomenclatureName: 'Насос',
    itemType: 'material',
    minStock: 1,
    maxStock: 5,
    groupId: null,
    groupName: null,
    unitId: null,
    unitName: 'шт',
    defaultWarehouseId: null,
    defaultWarehouseName: null,
    ...p,
  } as WarehouseStockListItem;
}

describe('rollupStockByParent', () => {
  it('складывает варианты одного родителя на одном складе; мин/макс свода пусты', () => {
    const rows = rollupStockByParent([
      stock({ id: 'a', qty: 2, reservedQty: 1, availableQty: 1, parentNomenclatureId: 'P', parentNomenclatureName: 'Масляный насос' }),
      stock({ id: 'b', qty: 5, reservedQty: 0, availableQty: 5, parentNomenclatureId: 'P', parentNomenclatureName: 'Масляный насос' }),
      stock({ id: 'c', qty: 1, parentNomenclatureId: 'P', parentNomenclatureName: 'Масляный насос', warehouseId: 'wh2' }),
      stock({ id: 'solo', qty: 9 }),
    ]);
    expect(rows.map((r) => [r.nomenclatureId, r.warehouseId, r.qty, r.reservedQty, r.availableQty, r.variantCount ?? 0])).toEqual([
      ['P', 'wh1', 7, 1, 6, 2],
      ['P', 'wh2', 1, 0, 0, 1],
      ['solo', 'wh1', 9, 0, 0, 0],
    ]);
    expect(rows[0]!.nomenclatureName).toBe('Масляный насос');
    expect(rows[0]!.minStock).toBeNull();
    expect(rows[0]!.parentNomenclatureId).toBeNull();
  });
  it('без родителей — строки как были', () => {
    const src = [stock({ id: 'x', qty: 1 })];
    expect(rollupStockByParent(src)).toEqual(src);
  });
});

function nomRow(p: Partial<WarehouseNomenclatureListItem> & { id: string }): WarehouseNomenclatureListItem {
  return { code: '', name: p.id, itemType: 'material', groupId: null, unitId: null, barcode: null, minStock: null, maxStock: null, defaultWarehouseId: null, specJson: null, isActive: true, createdAt: 0, updatedAt: 0, deletedAt: null, groupName: null, unitName: null, defaultWarehouseName: null, ...p } as WarehouseNomenclatureListItem;
}

describe('collapseNomenclatureVariants', () => {
  it('прячет варианты под родителя из того же списка и считает их', () => {
    const r = collapseNomenclatureVariants([nomRow({ id: 'P' }), nomRow({ id: 'a', parentNomenclatureId: 'P' }), nomRow({ id: 'b', parentNomenclatureId: 'P' }), nomRow({ id: 'z' })]);
    expect(r.rows.map((x) => x.id)).toEqual(['P', 'z']);
    expect(r.variantCountByParent.get('P')).toBe(2);
  });
  it('вариант чужого родителя остаётся видимым', () => {
    const r = collapseNomenclatureVariants([nomRow({ id: 'a', parentNomenclatureId: 'ELSEWHERE' })]);
    expect(r.rows.map((x) => x.id)).toEqual(['a']);
  });
});
