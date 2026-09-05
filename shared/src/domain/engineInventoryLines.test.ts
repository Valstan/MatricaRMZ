import { describe, expect, it } from 'vitest';

import {
  diffInventoryLines,
  inventoryLineKeys,
  inventoryRawRowsFromPayload,
  inventoryRowFromLine,
  inventoryRowsFromLines,
  lineFromInventoryRow,
  sameLineContent,
  type EngineInventoryLineRow,
} from './engineInventoryLines.js';
import { buildSupplyRequestItemsFromInventory, normalizeEngineInventoryRow } from './repairChecklist.js';

const ctx = (i: number, key: string) => ({
  id: `line-${i}`,
  operationId: 'op-1',
  engineEntityId: 'eng-1',
  lineKey: key,
  sortOrder: i,
  createdAt: 100,
  updatedAt: 200,
});

const brandRow = {
  part_name: 'Поршень',
  assembly_unit_number: '01',
  part_number: '236-1004015',
  stamped_number: '7',
  bom_variant_group: null,
  quantity: 6,
  present: true,
  actual_qty: 6,
  repairable_qty: 4,
  scrap_qty: 1,
  replace_qty: 1,
  replenishment_branch: 'purchase',
  scrap_reason: 'трещина',
  in_completeness_act: true,
  in_defect_act: false,
  in_defect_act_override: true,
  __brand_source: 'engine_brand',
  __brand_part_id: 'part-a',
  __photos: JSON.stringify([{ id: 'f1', name: 'a.jpg' }]),
  __selected: '1',
};

describe('inventoryLineKeys — ключ строки внутри листа', () => {
  it('id детали важнее текста; brand-id важнее ручного', () => {
    const keys = inventoryLineKeys([
      { __brand_part_id: 'p1', __part_id: 'p2', part_name: 'X' },
      { __part_id: 'p2', part_name: 'Y' },
      { part_name: ' Вал ', assembly_unit_number: '02', part_number: 'N-1' },
    ]);
    expect(keys).toEqual(['id:p1', 'id:p2', 'sig:вал|02|n-1']);
  });

  it('дубли ключа получают порядковый суффикс, чтобы две одинаковые ручные строки не схлопнулись', () => {
    const keys = inventoryLineKeys([{ part_name: 'Шайба' }, { part_name: 'шайба' }, { part_name: 'Шайба' }]);
    expect(keys).toEqual(['sig:шайба||', 'sig:шайба||#1', 'sig:шайба||#2']);
  });
});

describe('lineFromInventoryRow ↔ inventoryRowFromLine — round-trip', () => {
  it('brand-managed строка с фото и отметкой печати возвращается в ту же raw-форму', () => {
    const line = lineFromInventoryRow(brandRow, ctx(0, 'id:part-a'));
    expect(line).toMatchObject({
      part_id: 'part-a',
      brand_managed: true,
      stamped_number: '7',
      selected: true,
      in_completeness_act: true,
      in_defect_act: false,
      in_completeness_act_override: null,
      in_defect_act_override: true,
      scrap_qty: 1,
      replace_qty: 1,
      repairable_qty: 4,
    });
    expect(JSON.parse(String(line.photos_json))).toEqual([{ id: 'f1', name: 'a.jpg' }]);

    const back = inventoryRowFromLine(line);
    // Та же нормализованная строка — значит все shared-хелперы видят то же, что и раньше.
    expect(normalizeEngineInventoryRow(back)).toEqual(normalizeEngineInventoryRow(brandRow));
    expect(back.__brand_source).toBe('engine_brand');
    expect(back.__brand_part_id).toBe('part-a');
    expect(back.__part_id).toBeUndefined();
    expect(back.__selected).toBe(true);
    expect(JSON.parse(String(back.__photos))).toEqual([{ id: 'f1', name: 'a.jpg' }]);
    expect(buildSupplyRequestItemsFromInventory([back])).toEqual(buildSupplyRequestItemsFromInventory([brandRow]));
  });

  it('ручная строка без мета — без лишних ключей на выходе', () => {
    const raw = { part_name: 'Прокладка', quantity: 2, present: false, __part_id: 'part-m' };
    const line = lineFromInventoryRow(raw, ctx(3, 'id:part-m'));
    expect(line.brand_managed).toBe(false);
    expect(line.part_id).toBe('part-m');
    expect(line.photos_json).toBeNull();
    expect(line.in_completeness_act).toBeNull();
    const back = inventoryRowFromLine(line);
    expect(back.__part_id).toBe('part-m');
    expect('__brand_source' in back).toBe(false);
    expect('__photos' in back).toBe(false);
    expect('__selected' in back).toBe(false);
    expect('stamped_number' in back).toBe(false);
    expect('in_completeness_act' in back).toBe(false);
  });

  it('невалидный __photos не превращается в строку таблицы', () => {
    const line = lineFromInventoryRow({ part_name: 'A', __photos: '{oops' }, ctx(0, 'sig:a||'));
    expect(line.photos_json).toBeNull();
  });
});

describe('inventoryRowsFromLines / inventoryRawRowsFromPayload', () => {
  it('живые строки идут по sort_order, погашенные выпадают', () => {
    const a = lineFromInventoryRow({ part_name: 'B' }, ctx(1, 'sig:b||'));
    const b = lineFromInventoryRow({ part_name: 'A' }, ctx(0, 'sig:a||'));
    const dead = { ...lineFromInventoryRow({ part_name: 'C' }, ctx(2, 'sig:c||')), deleted_at: 5 };
    expect(inventoryRowsFromLines([a, dead, b]).map((r) => r.part_name)).toEqual(['A', 'B']);
  });

  it('payload без таблицы или с мусором даёт пустой список', () => {
    expect(inventoryRawRowsFromPayload(null)).toEqual([]);
    expect(inventoryRawRowsFromPayload({ answers: {} })).toEqual([]);
    expect(inventoryRawRowsFromPayload({ answers: { engine_inventory_items: { rows: [null, 1, { part_name: 'X' }] } } })).toEqual([{ part_name: 'X' }]);
  });
});

describe('diffInventoryLines — одна галочка = одна транзакция', () => {
  const desiredFrom = (rows: Record<string, unknown>[], ts = 300): EngineInventoryLineRow[] => {
    const keys = inventoryLineKeys(rows);
    return rows.map((r, i) => lineFromInventoryRow(r, { ...ctx(i, keys[i]!), id: `new-${i}`, createdAt: ts, updatedAt: ts }));
  };

  it('пустая таблица — всё вставляется', () => {
    const d = diffInventoryLines([], desiredFrom([{ part_name: 'A' }, { part_name: 'B' }]), 300);
    expect(d.insert).toHaveLength(2);
    expect(d.update).toEqual([]);
    expect(d.tombstone).toEqual([]);
  });

  it('изменилась одна строка — одна update с прежним id, остальные unchanged', () => {
    const existing = desiredFrom([{ part_name: 'A', quantity: 1 }, { part_name: 'B', quantity: 1 }], 100).map((l, i) => ({ ...l, id: `old-${i}` }));
    const d = diffInventoryLines(existing, desiredFrom([{ part_name: 'A', quantity: 1 }, { part_name: 'B', quantity: 2 }]), 300);
    expect(d.unchanged).toBe(1);
    expect(d.insert).toEqual([]);
    expect(d.update).toHaveLength(1);
    expect(d.update[0]).toMatchObject({ id: 'old-1', created_at: 100, updated_at: 300, quantity: 2, deleted_at: null });
  });

  it('строка исчезла из листа — тумстоун; вернулась — update той же строки с deleted_at=null', () => {
    const existing = desiredFrom([{ part_name: 'A' }, { part_name: 'B' }], 100).map((l, i) => ({ ...l, id: `old-${i}` }));
    const d1 = diffInventoryLines(existing, desiredFrom([{ part_name: 'A' }]), 300);
    expect(d1.tombstone).toHaveLength(1);
    expect(d1.tombstone[0]).toMatchObject({ id: 'old-1', deleted_at: 300 });
    const afterDelete = [existing[0]!, d1.tombstone[0]!];
    const d2 = diffInventoryLines(afterDelete, desiredFrom([{ part_name: 'A' }, { part_name: 'B' }]), 400);
    expect(d2.insert).toEqual([]);
    expect(d2.update).toHaveLength(1);
    expect(d2.update[0]).toMatchObject({ id: 'old-1', deleted_at: null, updated_at: 400 });
    // Повторно гасить уже погашенное не нужно.
    const d3 = diffInventoryLines(afterDelete, desiredFrom([{ part_name: 'A' }]), 500);
    expect(d3.tombstone).toEqual([]);
  });

  it('перестановка строк — update только sort_order, новых строк нет', () => {
    const existing = desiredFrom([{ part_name: 'A' }, { part_name: 'B' }], 100).map((l, i) => ({ ...l, id: `old-${i}` }));
    const d = diffInventoryLines(existing, desiredFrom([{ part_name: 'B' }, { part_name: 'A' }]), 300);
    expect(d.insert).toEqual([]);
    expect(d.tombstone).toEqual([]);
    expect(d.update.map((u) => [u.id, u.sort_order])).toEqual([[ 'old-1', 0 ], [ 'old-0', 1 ]]);
  });

  it('sameLineContent игнорирует служебные поля', () => {
    const [a] = desiredFrom([{ part_name: 'A' }]);
    expect(sameLineContent(a!, { ...a!, id: 'x', updated_at: 9, last_server_seq: 7, sync_status: 'pending' })).toBe(true);
    expect(sameLineContent(a!, { ...a!, quantity: 5 })).toBe(false);
  });
});
