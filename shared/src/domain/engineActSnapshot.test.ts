import { describe, expect, it } from 'vitest';

import {
  actOperationType,
  computeCustomerClaim,
  computeInventoryShortage,
  engineActSnapshotSignature,
  ENGINE_CLAIM_ACT_TYPE,
  ENGINE_COMPLETENESS_ACT_TYPE,
  ENGINE_DEFECT_ACT_TYPE,
} from './engineActSnapshot.js';
import type { EngineInventoryRow } from './repairChecklist.js';

function row(p: Partial<EngineInventoryRow>): EngineInventoryRow {
  return {
    part_name: 'Деталь',
    assembly_unit_number: '',
    part_number: '',
    bom_variant_group: null,
    quantity: 1,
    present: false,
    actual_qty: 0,
    repairable_qty: 1,
    scrap_qty: 0,
    replace_qty: 0,
    replenishment_branch: null,
    ...p,
  };
}

describe('actOperationType', () => {
  it('maps act types to operationType strings', () => {
    expect(actOperationType('completeness')).toBe(ENGINE_COMPLETENESS_ACT_TYPE);
    expect(actOperationType('defect')).toBe(ENGINE_DEFECT_ACT_TYPE);
    expect(actOperationType('claim')).toBe(ENGINE_CLAIM_ACT_TYPE);
  });
});

describe('computeCustomerClaim (Ф4)', () => {
  it('collects customer-routed defective rows with claim_qty = scrap + replace', () => {
    const s = computeCustomerClaim([
      row({ part_name: 'A', quantity: 5, scrap_qty: 2, replace_qty: 1, replenishment_branch: 'customer' }),
      row({ part_name: 'B', quantity: 3, scrap_qty: 0, replace_qty: 2, replenishment_branch: 'customer' }),
    ]);
    expect(s.total).toBe(2);
    expect(s.claimUnits).toBe(5);
    expect(s.items[0]!.claim_qty).toBe(3);
    expect(s.items[1]!.claim_qty).toBe(2);
  });

  it('ignores rows on other branches and rows without defect', () => {
    const s = computeCustomerClaim([
      row({ part_name: 'Закупка', replace_qty: 1, replenishment_branch: 'purchase' }),
      row({ part_name: 'Ремонт', scrap_qty: 1, replenishment_branch: 'repair' }),
      row({ part_name: 'Незадан', replace_qty: 1, replenishment_branch: null }),
      row({ part_name: 'Без дефекта', replenishment_branch: 'customer' }), // scrap=replace=0
    ]);
    expect(s.total).toBe(0);
    expect(s.claimUnits).toBe(0);
    expect(s.items).toEqual([]);
  });

  it('scrap-only customer row is claimable (утиль тоже восполняет заказчик)', () => {
    const s = computeCustomerClaim([row({ quantity: 4, scrap_qty: 3, replenishment_branch: 'customer' })]);
    expect(s.total).toBe(1);
    expect(s.claimUnits).toBe(3);
  });
});

describe('computeInventoryShortage', () => {
  it('flags rows where actual_qty < quantity and sums the missing units', () => {
    const s = computeInventoryShortage([
      row({ part_name: 'A', quantity: 3, actual_qty: 1 }), // missing 2
      row({ part_name: 'B', quantity: 2, actual_qty: 2 }), // complete
      row({ part_name: 'C', quantity: 1, actual_qty: 0 }), // missing 1
    ]);
    expect(s.total).toBe(2);
    expect(s.missingUnits).toBe(3);
    expect(s.items.map((i) => i.part_name)).toEqual(['A', 'C']);
    expect(s.items[0]!.missing).toBe(2);
  });

  it('treats a fully present list as no shortage', () => {
    const s = computeInventoryShortage([row({ quantity: 2, present: true, actual_qty: 2 })]);
    expect(s.total).toBe(0);
    expect(s.missingUnits).toBe(0);
    expect(s.items).toEqual([]);
  });

  it('clamps negative/over actuals defensively', () => {
    const s = computeInventoryShortage([row({ quantity: 2, actual_qty: 5 })]); // over → no shortage
    expect(s.total).toBe(0);
  });
});

describe('engineActSnapshotSignature', () => {
  const base = {
    actType: 'completeness' as const,
    rows: [row({ part_name: 'A', quantity: 2, actual_qty: 1 })],
    answers: { contract_number: { kind: 'text' as const, value: 'C-1' } },
  };

  it('is stable for identical content', () => {
    expect(engineActSnapshotSignature(base)).toBe(engineActSnapshotSignature({ ...base }));
  });

  it('changes when a row value changes', () => {
    const other = { ...base, rows: [row({ part_name: 'A', quantity: 2, actual_qty: 2 })] };
    expect(engineActSnapshotSignature(base)).not.toBe(engineActSnapshotSignature(other));
  });

  it('changes when the act type changes', () => {
    expect(engineActSnapshotSignature(base)).not.toBe(engineActSnapshotSignature({ ...base, actType: 'defect' }));
  });

  it('changes when answers change', () => {
    const other = { ...base, answers: { contract_number: { kind: 'text' as const, value: 'C-2' } } };
    expect(engineActSnapshotSignature(base)).not.toBe(engineActSnapshotSignature(other));
  });

  it('changes when replenishment_branch changes (Ф4: ветка — часть контента акта)', () => {
    const a = { ...base, rows: [row({ replace_qty: 1, replenishment_branch: 'customer' as const })] };
    const b = { ...base, rows: [row({ replace_qty: 1, replenishment_branch: 'purchase' as const })] };
    expect(engineActSnapshotSignature(a)).not.toBe(engineActSnapshotSignature(b));
  });
});
