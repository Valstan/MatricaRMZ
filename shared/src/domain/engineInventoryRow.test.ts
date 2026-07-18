import { describe, expect, it } from 'vitest';

import {
  buildAutoWithdrawReason,
  buildRepairFundIntakeFromInventory,
  buildScrapIntakeFromInventory,
  buildStampedInstancesFromInventory,
  buildSupplyRequestItemsFromInventory,
  engineInventoryRowSignature,
  listScrapPartNames,
  mergeLegacyChecklistAnswers,
  normalizeEngineInventoryRow,
  normalizeEngineInventoryRows,
  rowDefectQty,
  rowGoesToPurchase,
  rowHasDefect,
  summarizeReplenishment,
} from './repairChecklist.js';

describe('normalizeEngineInventoryRow', () => {
  it('clamps quantity to non-negative integer', () => {
    const { row } = normalizeEngineInventoryRow({ quantity: -3.7 });
    expect(row.quantity).toBe(0);
  });

  it('coerces present=true → actual_qty=quantity', () => {
    const { row } = normalizeEngineInventoryRow({
      quantity: 5,
      present: true,
      actual_qty: 2,
    });
    expect(row.actual_qty).toBe(5);
  });

  it('Т7: present=false → actual_qty/дефектовка обнуляются', () => {
    const { row } = normalizeEngineInventoryRow({
      quantity: 5,
      present: false,
      actual_qty: 9,
      scrap_qty: 0,
      replace_qty: 0,
    });
    expect(row.present).toBe(false);
    expect(row.actual_qty).toBe(0);
    expect(row.repairable_qty).toBe(0);
  });

  it('computes repairable_qty = quantity - scrap_qty - replace_qty', () => {
    const { row } = normalizeEngineInventoryRow({
      quantity: 10,
      scrap_qty: 3,
      replace_qty: 2,
    });
    expect(row.repairable_qty).toBe(5);
    expect(row.scrap_qty).toBe(3);
    expect(row.replace_qty).toBe(2);
  });

  it('shrinks replace_qty when scrap+replace exceeds quantity', () => {
    const { row } = normalizeEngineInventoryRow({
      quantity: 4,
      scrap_qty: 3,
      replace_qty: 5,
    });
    expect(row.scrap_qty).toBe(3);
    expect(row.replace_qty).toBe(1); // 4 - 3
    expect(row.repairable_qty).toBe(0);
  });

  it('present=true, scrap+replace=0 → всё ремонтопригодно', () => {
    const { row } = normalizeEngineInventoryRow({ quantity: 7, present: true });
    expect(row.repairable_qty).toBe(7);
    expect(row.scrap_qty).toBe(0);
    expect(row.replace_qty).toBe(0);
  });

  it('Т7: present=false без дефекта → repairable=0 (нет в комплектности → нет в дефектовке)', () => {
    const { row } = normalizeEngineInventoryRow({ quantity: 7, present: false });
    expect(row.present).toBe(false);
    expect(row.repairable_qty).toBe(0);
  });

  it('Т7: дефект подразумевает наличие — scrap>0 без present → present=true', () => {
    const { row } = normalizeEngineInventoryRow({ quantity: 4, scrap_qty: 1 });
    expect(row.present).toBe(true);
    expect(row.actual_qty).toBe(4);
    expect(row.scrap_qty).toBe(1);
    expect(row.repairable_qty).toBe(3);
  });

  it('empty bom_variant_group string normalises to null', () => {
    const { row } = normalizeEngineInventoryRow({ quantity: 1, bom_variant_group: '   ' });
    expect(row.bom_variant_group).toBeNull();
  });

  it('keeps non-empty bom_variant_group string', () => {
    const { row } = normalizeEngineInventoryRow({ quantity: 1, bom_variant_group: 'variant-A' });
    expect(row.bom_variant_group).toBe('variant-A');
  });

  it('reports changed=true when any normalization happened', () => {
    const { changed } = normalizeEngineInventoryRow({
      part_name: 'Поршень',
      quantity: 5.9,
    });
    expect(changed).toBe(true);
  });

  it('reports changed=false when input is already canonical', () => {
    const canonical = {
      part_name: 'Поршень',
      assembly_unit_number: '12',
      part_number: 'PRT-1',
      bom_variant_group: null,
      quantity: 5,
      present: false,
      actual_qty: 0,
      repairable_qty: 0,
      scrap_qty: 0,
      replace_qty: 0,
      replenishment_branch: null,
    };
    const { changed } = normalizeEngineInventoryRow(canonical);
    expect(changed).toBe(false);
  });
});

describe('normalizeEngineInventoryRows', () => {
  it('handles empty array', () => {
    expect(normalizeEngineInventoryRows([])).toEqual({ rows: [], changed: false });
  });

  it('returns changed=true if any row changed', () => {
    const result = normalizeEngineInventoryRows([
      {
        part_name: 'A',
        quantity: 1,
        repairable_qty: 1,
        scrap_qty: 0,
        replace_qty: 0,
        present: false,
        actual_qty: 0,
        assembly_unit_number: '',
        part_number: '',
        bom_variant_group: null,
      },
      { part_name: 'B', quantity: 'oops' },
    ]);
    expect(result.changed).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]?.quantity).toBe(0);
  });
});

describe('engineInventoryRowSignature', () => {
  it('builds case-insensitive signature from name + assembly + number', () => {
    const sig1 = engineInventoryRowSignature({
      part_name: 'Поршень',
      assembly_unit_number: '12',
      part_number: 'PRT-1',
    });
    const sig2 = engineInventoryRowSignature({
      part_name: 'поршень  ',
      assembly_unit_number: '12',
      part_number: 'prt-1',
    });
    expect(sig1).toBe(sig2);
  });

  it('handles empty fields', () => {
    const sig = engineInventoryRowSignature({
      part_name: 'X',
      assembly_unit_number: '',
      part_number: '',
    });
    expect(sig).toBe('x||');
  });
});

describe('mergeLegacyChecklistAnswers', () => {
  it('merges matched defect+completeness rows by part_name', () => {
    const merged = mergeLegacyChecklistAnswers({
      defectRows: [
        { part_name: 'Поршень', part_number: 'PRT-1', quantity: 4, repairable_qty: 3, scrap_qty: 1 },
      ],
      completenessRows: [
        { part_name: 'Поршень', assembly_unit_number: '12', quantity: 4, present: true, actual_qty: 4 },
      ],
    });
    expect(merged).toHaveLength(1);
    const row = merged[0]!;
    expect(row.part_name).toBe('Поршень');
    expect(row.part_number).toBe('PRT-1');
    expect(row.assembly_unit_number).toBe('12');
    expect(row.quantity).toBe(4);
    expect(row.present).toBe(true);
    expect(row.actual_qty).toBe(4);
    expect(row.scrap_qty).toBe(1);
    expect(row.repairable_qty).toBe(3);
    expect(row.replace_qty).toBe(0);
  });

  it('Т7: defect-only row → present инферится true (дефект подразумевает наличие)', () => {
    const merged = mergeLegacyChecklistAnswers({
      defectRows: [{ part_name: 'X', quantity: 2, scrap_qty: 1, repairable_qty: 1 }],
    });
    expect(merged).toHaveLength(1);
    const row = merged[0]!;
    expect(row.present).toBe(true);
    expect(row.actual_qty).toBe(2);
    expect(row.scrap_qty).toBe(1);
    expect(row.repairable_qty).toBe(1);
  });

  it('completeness-only present=true → defect defaults (all repairable)', () => {
    const merged = mergeLegacyChecklistAnswers({
      completenessRows: [
        { part_name: 'Y', assembly_unit_number: '99', quantity: 3, present: true, actual_qty: 3 },
      ],
    });
    expect(merged).toHaveLength(1);
    const row = merged[0]!;
    expect(row.assembly_unit_number).toBe('99');
    expect(row.present).toBe(true);
    expect(row.actual_qty).toBe(3);
    expect(row.repairable_qty).toBe(3);
    expect(row.scrap_qty).toBe(0);
    expect(row.replace_qty).toBe(0);
  });

  it('Т7: completeness-only present=false → не на месте, дефектовки нет (repairable=0)', () => {
    const merged = mergeLegacyChecklistAnswers({
      completenessRows: [
        { part_name: 'Y', assembly_unit_number: '99', quantity: 3, present: false, actual_qty: 2 },
      ],
    });
    expect(merged).toHaveLength(1);
    const row = merged[0]!;
    expect(row.present).toBe(false);
    expect(row.actual_qty).toBe(0);
    expect(row.repairable_qty).toBe(0);
  });

  it('matches part_name case-insensitively after trim', () => {
    const merged = mergeLegacyChecklistAnswers({
      defectRows: [{ part_name: '  Поршень ', quantity: 1, scrap_qty: 0 }],
      completenessRows: [{ part_name: 'поршень', quantity: 1, present: true }],
    });
    // Один совпавший ряд (а не два).
    expect(merged).toHaveLength(1);
    expect(merged[0]!.present).toBe(true);
  });

  it('takes max(defect.quantity, completeness.quantity) when matched', () => {
    const merged = mergeLegacyChecklistAnswers({
      defectRows: [{ part_name: 'A', quantity: 3 }],
      completenessRows: [{ part_name: 'A', quantity: 5 }],
    });
    expect(merged[0]!.quantity).toBe(5);
  });

  it('handles both empty', () => {
    expect(mergeLegacyChecklistAnswers({})).toEqual([]);
  });
});

describe('replenishment_branch (Ф3)', () => {
  it('normalizes valid branch and nulls invalid (present=true)', () => {
    expect(normalizeEngineInventoryRow({ present: true, replenishment_branch: 'purchase' }).row.replenishment_branch).toBe('purchase');
    expect(normalizeEngineInventoryRow({ present: true, replenishment_branch: 'repair' }).row.replenishment_branch).toBe('repair');
    expect(normalizeEngineInventoryRow({ present: true, replenishment_branch: 'customer' }).row.replenishment_branch).toBe('customer');
    expect(normalizeEngineInventoryRow({ present: true, replenishment_branch: 'bogus' }).row.replenishment_branch).toBeNull();
    expect(normalizeEngineInventoryRow({}).row.replenishment_branch).toBeNull();
  });

  it('Т7: present=false → replenishment_branch обнуляется (нет дефектовки → нет восполнения)', () => {
    expect(normalizeEngineInventoryRow({ present: false, replenishment_branch: 'purchase' }).row.replenishment_branch).toBeNull();
  });

  it('rowGoesToPurchase: replace_qty>0 with purchase/null, excludes customer/repair', () => {
    expect(rowGoesToPurchase({ replace_qty: 2, replenishment_branch: 'purchase' })).toBe(true);
    expect(rowGoesToPurchase({ replace_qty: 2, replenishment_branch: null })).toBe(true); // back-compat default
    expect(rowGoesToPurchase({ replace_qty: 2, replenishment_branch: 'customer' })).toBe(false);
    expect(rowGoesToPurchase({ replace_qty: 2, replenishment_branch: 'repair' })).toBe(false);
    expect(rowGoesToPurchase({ replace_qty: 0, replenishment_branch: 'purchase' })).toBe(false); // not defective
  });

  it('buildSupplyRequestItemsFromInventory excludes customer/repair-routed rows', () => {
    const rows = [
      { part_name: 'Купить', quantity: 1, replace_qty: 1, replenishment_branch: 'purchase' },
      { part_name: 'Незадан', quantity: 1, replace_qty: 1 }, // null → purchase (back-compat)
      { part_name: 'Заказчик', quantity: 1, replace_qty: 1, replenishment_branch: 'customer' },
      { part_name: 'Ремонт', quantity: 1, replace_qty: 1, replenishment_branch: 'repair' },
    ];
    const items = buildSupplyRequestItemsFromInventory(rows);
    expect(items.map((i) => i.name).sort()).toEqual(['Купить', 'Незадан']);
  });

  it('summarizeReplenishment counts branches and purchase draft', () => {
    const s = summarizeReplenishment([
      { quantity: 1, replace_qty: 1, replenishment_branch: 'purchase' },
      { quantity: 1, replace_qty: 1, replenishment_branch: 'customer' },
      { quantity: 1, replace_qty: 1, replenishment_branch: 'repair' },
      { quantity: 1, replace_qty: 1 }, // unrouted
      { quantity: 1, replace_qty: 0, replenishment_branch: 'purchase' }, // not to-replenish
    ]);
    expect(s.toReplenish).toBe(4);
    expect(s.purchase).toBe(1);
    expect(s.customer).toBe(1);
    expect(s.repair).toBe(1);
    expect(s.unrouted).toBe(1);
    expect(s.toPurchase).toBe(2); // purchase + unrouted
  });
});

describe('defect trigger (Ф4)', () => {
  it('rowDefectQty/rowHasDefect: дефект = утиль + замена', () => {
    expect(rowDefectQty({ scrap_qty: 2, replace_qty: 1 })).toBe(3);
    expect(rowHasDefect({ scrap_qty: 1, replace_qty: 0 })).toBe(true);
    expect(rowHasDefect({ scrap_qty: 0, replace_qty: 1 })).toBe(true);
    expect(rowHasDefect({ scrap_qty: 0, replace_qty: 0 })).toBe(false);
  });

  it('summarizeReplenishment counts scrap-only rows as to-replenish but not to-purchase', () => {
    const s = summarizeReplenishment([
      { quantity: 3, scrap_qty: 2, replace_qty: 0, replenishment_branch: 'customer' },
      { quantity: 2, scrap_qty: 1, replace_qty: 0 }, // unrouted scrap-only — дефект, но в закупку не идёт
    ]);
    expect(s.toReplenish).toBe(2);
    expect(s.customer).toBe(1);
    expect(s.unrouted).toBe(1);
    expect(s.toPurchase).toBe(0); // в закупку идут только единицы «заменить новой»
  });
});

describe('buildRepairFundIntakeFromInventory (Ф1 ремфонда)', () => {
  it('берёт present && repairable_qty, qty = repairable_qty, partId из __brand_part_id/__part_id', () => {
    const r = buildRepairFundIntakeFromInventory([
      // present, 7 шт, 2 утиль → repairable 5 → +5
      { part_name: 'Гильза', quantity: 7, present: true, scrap_qty: 2, replace_qty: 0, __brand_part_id: 'p1' },
      // present, всё ремонтопригодно → +3
      { part_name: 'Поршень', quantity: 3, present: true, scrap_qty: 0, replace_qty: 0, __part_id: 'p2' },
      // НЕ present — пропускается
      { part_name: 'Вал', quantity: 4, present: false, scrap_qty: 0, replace_qty: 0, __part_id: 'p3' },
      // present, но всё утиль → repairable 0 → пропускается
      { part_name: 'Кольцо', quantity: 2, present: true, scrap_qty: 2, replace_qty: 0, __part_id: 'p4' },
      // present, repairable, но нет partId → skipped
      { part_name: 'Шпонка', quantity: 1, present: true, scrap_qty: 0, replace_qty: 0 },
    ]);
    expect(r.items).toEqual([
      { partId: 'p1', partLabel: 'Гильза', qty: 5 },
      { partId: 'p2', partLabel: 'Поршень', qty: 3 },
    ]);
    expect(r.skippedNoPartId).toBe(1);
  });

  it('агрегирует одинаковые partId', () => {
    const r = buildRepairFundIntakeFromInventory([
      { part_name: 'Гильза', quantity: 2, present: true, __brand_part_id: 'p1' },
      { part_name: 'Гильза', quantity: 3, present: true, __brand_part_id: 'p1' },
    ]);
    expect(r.items).toEqual([{ partId: 'p1', partLabel: 'Гильза', qty: 5 }]);
  });
});

describe('buildScrapIntakeFromInventory (Ф6, G6 — утиль в scrap-локацию)', () => {
  it('берёт строки scrap_qty>0, qty = scrap_qty, агрегирует по partId, без partId → skipped', () => {
    const r = buildScrapIntakeFromInventory([
      { part_name: 'Гильза', quantity: 7, present: true, scrap_qty: 2, replace_qty: 0, __brand_part_id: 'p1' },
      { part_name: 'Гильза', quantity: 3, present: true, scrap_qty: 1, replace_qty: 0, __brand_part_id: 'p1' },
      // без утиля — пропускается
      { part_name: 'Поршень', quantity: 3, present: true, scrap_qty: 0, replace_qty: 0, __part_id: 'p2' },
      // утиль без привязки — skipped
      { part_name: 'Шпонка', quantity: 1, present: true, scrap_qty: 1, replace_qty: 0 },
    ]);
    expect(r.items).toEqual([{ partId: 'p1', partLabel: 'Гильза', qty: 3 }]);
    expect(r.skippedNoPartId).toBe(1);
  });

  it('scrap_qty клампится количеством (нормализация)', () => {
    const r = buildScrapIntakeFromInventory([
      { part_name: 'Кольцо', quantity: 2, present: true, scrap_qty: 5, replace_qty: 0, __part_id: 'p4' },
    ]);
    expect(r.items).toEqual([{ partId: 'p4', partLabel: 'Кольцо', qty: 2 }]);
  });
});

describe('buildStampedInstancesFromInventory (Ф3 ремфонда — личные номера)', () => {
  it('берёт только строки с непустым stamped_number; classification по приоритету утиль>замена>ремонт', () => {
    const r = buildStampedInstancesFromInventory([
      // ремонтопригодна (present, без дефекта) → repairable
      { part_name: 'Гильза', quantity: 1, present: true, stamped_number: 'A-1', __brand_part_id: 'p1' },
      // утиль (scrap>0) → classification scrap, даже если есть и замена
      { part_name: 'Поршень', quantity: 1, present: true, scrap_qty: 1, replace_qty: 0, stamped_number: 'B-2', __part_id: 'p2' },
      // замена (replace>0, нет утиля) → replace
      { part_name: 'Вал', quantity: 1, present: true, scrap_qty: 0, replace_qty: 1, stamped_number: 'C-3', __part_id: 'p3' },
      // без личного номера — пропускается
      { part_name: 'Кольцо', quantity: 2, present: true, __part_id: 'p4' },
    ]);
    expect(r.items).toEqual([
      { partId: 'p1', partLabel: 'Гильза', stampedNumber: 'A-1', classification: 'repairable', repairableQty: 1, scrapQty: 0, replaceQty: 0 },
      { partId: 'p2', partLabel: 'Поршень', stampedNumber: 'B-2', classification: 'scrap', repairableQty: 0, scrapQty: 1, replaceQty: 0 },
      { partId: 'p3', partLabel: 'Вал', stampedNumber: 'C-3', classification: 'replace', repairableQty: 0, scrapQty: 0, replaceQty: 1 },
    ]);
    expect(r.skippedNoPartId).toBe(0);
  });

  it('строка с номером, но без partId → skippedNoPartId, не в items', () => {
    const r = buildStampedInstancesFromInventory([
      { part_name: 'Шпонка', quantity: 1, present: true, stamped_number: 'X-9' },
    ]);
    expect(r.items).toEqual([]);
    expect(r.skippedNoPartId).toBe(1);
  });

  it('дедуп по (partId, stamped_number) — один физический экземпляр учитывается один раз', () => {
    const r = buildStampedInstancesFromInventory([
      { part_name: 'Гильза', quantity: 1, present: true, stamped_number: 'A-1', __brand_part_id: 'p1' },
      { part_name: 'Гильза', quantity: 1, present: true, stamped_number: 'a-1', __brand_part_id: 'p1' },
    ]);
    expect(r.items).toHaveLength(1);
  });

  it('строка с нулевой диспозицией (quantity 0) пропускается', () => {
    const r = buildStampedInstancesFromInventory([
      { part_name: 'Втулка', quantity: 0, present: false, stamped_number: 'Z-0', __part_id: 'p5' },
    ]);
    expect(r.items).toEqual([]);
  });
});

describe('listScrapPartNames / buildAutoWithdrawReason', () => {
  const payloadWith = (rows: unknown[]) => ({
    kind: 'repair_checklist',
    answers: { engine_inventory_items: { kind: 'table', rows } },
  });

  it('возвращает имена строк с scrap_qty > 0, dedup, порядок строк', () => {
    const names = listScrapPartNames(
      payloadWith([
        { part_name: 'Картер верхний', quantity: 1, present: true, scrap_qty: 1 },
        { part_name: 'Гильза', quantity: 2, present: true, scrap_qty: 0, replace_qty: 1 },
        { part_name: 'Картер верхний', quantity: 1, present: true, scrap_qty: 1 },
      ]),
    );
    expect(names).toEqual(['Картер верхний']);
  });

  it('пустой payload / нет утиля → []', () => {
    expect(listScrapPartNames(null)).toEqual([]);
    expect(listScrapPartNames(payloadWith([{ part_name: 'Гильза', quantity: 1, present: true }]))).toEqual([]);
  });

  it('авто-причина: одна деталь / несколько / пусто', () => {
    expect(buildAutoWithdrawReason(['Картер верхний'])).toBe('Деталь признана утильной: Картер верхний');
    expect(buildAutoWithdrawReason(['Картер', 'Гильза'])).toBe('Детали признаны утильными: Картер, Гильза');
    expect(buildAutoWithdrawReason([])).toBe('Утильная деталь в дефектовке двигателя');
  });
});
