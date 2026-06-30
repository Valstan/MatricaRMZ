import { describe, expect, it } from 'vitest';

import {
  parseRepairFundRequirementPayload,
  repairFundRequirementSignature,
  selectRequirementInstances,
  type RepairFundInstancePayload,
} from './repairFundInstance.js';

function inst(stampedNumber: string, classification: RepairFundInstancePayload['classification']): RepairFundInstancePayload {
  return {
    kind: 'repair_fund_instance',
    engineEntityId: 'eng1',
    nomenclatureId: 'nom-' + stampedNumber,
    partId: 'p-' + stampedNumber,
    partLabel: 'Деталь ' + stampedNumber,
    stampedNumber,
    classification,
    status: classification === 'scrap' ? 'scrapped' : classification === 'replace' ? 'replaced' : 'in_fund',
    capturedAt: 1000,
    capturedBy: 'verify',
  };
}

describe('selectRequirementInstances (Ф4)', () => {
  it('берёт только утиль/замену, ремонтопригодные отбрасывает', () => {
    const r = selectRequirementInstances([inst('B-2', 'repairable'), inst('A-1', 'scrap'), inst('C-3', 'replace')]);
    expect(r.map((i) => i.stampedNumber)).toEqual(['A-1', 'C-3']);
    expect(r.every((i) => i.classification !== 'repairable')).toBe(true);
  });

  it('сортирует по личному номеру', () => {
    const r = selectRequirementInstances([inst('Z-9', 'scrap'), inst('A-1', 'replace'), inst('M-5', 'scrap')]);
    expect(r.map((i) => i.stampedNumber)).toEqual(['A-1', 'M-5', 'Z-9']);
  });

  it('пустой вход → пусто', () => {
    expect(selectRequirementInstances([])).toEqual([]);
  });
});

describe('repairFundRequirementSignature (Ф4 дедуп)', () => {
  it('идентичный набор (в любом порядке) → одинаковая сигнатура', () => {
    const a = repairFundRequirementSignature({ instances: [inst('A-1', 'scrap'), inst('B-2', 'replace')] });
    const b = repairFundRequirementSignature({ instances: [inst('B-2', 'replace'), inst('A-1', 'scrap')] });
    expect(a).toBe(b);
  });

  it('смена классификации меняет сигнатуру', () => {
    const a = repairFundRequirementSignature({ instances: [inst('A-1', 'scrap')] });
    const b = repairFundRequirementSignature({ instances: [inst('A-1', 'replace')] });
    expect(a).not.toBe(b);
  });

  it('ремонтопригодные не влияют на сигнатуру (не входят в требование)', () => {
    const a = repairFundRequirementSignature({ instances: [inst('A-1', 'scrap')] });
    const b = repairFundRequirementSignature({ instances: [inst('A-1', 'scrap'), inst('B-2', 'repairable')] });
    expect(a).toBe(b);
  });
});

describe('parseRepairFundRequirementPayload', () => {
  it('round-trips снимок требования', () => {
    const payload = {
      kind: 'repair_fund_requirement_snapshot',
      engineEntityId: 'eng1',
      version: 2,
      instances: [inst('A-1', 'scrap')],
      header: { engineBrand: 'TEST-BRAND', engineNumber: 'TEST-001', contractNumber: 'C-1' },
      printedBy: 'verify',
      printedAt: 5000,
    };
    const parsed = parseRepairFundRequirementPayload(JSON.stringify(payload));
    expect(parsed?.version).toBe(2);
    expect(parsed?.instances).toHaveLength(1);
    expect(parsed?.instances[0]!.stampedNumber).toBe('A-1');
    expect(parsed?.header.engineNumber).toBe('TEST-001');
  });

  it('чужой kind → null', () => {
    expect(parseRepairFundRequirementPayload(JSON.stringify({ kind: 'other' }))).toBeNull();
    expect(parseRepairFundRequirementPayload(null)).toBeNull();
    expect(parseRepairFundRequirementPayload('not json')).toBeNull();
  });
});
