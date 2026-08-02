import { describe, expect, it } from 'vitest';

import {
  aggregateContractExecutionProgress,
  buildContractSectionOptions,
  canonicalContractSectionKey,
  classifyEngineContractBinding,
  computeObjectProgress,
  isContractAddonToken,
  isContractLaggingVsSchedule,
  linearScheduleExpectedProgressPct,
  parseContractExecutionParts,
  parseContractSections,
  sumEngineBrandQtyByBrandFromContractSections,
  type ContractSections,
} from './contract.js';

describe('contract domain regressions', () => {
  it('prioritizes customer accepted as 100% progress', () => {
    expect(
      computeObjectProgress({
        status_repair_started: true,
        status_customer_sent: true,
        status_customer_accepted: true,
      }),
    ).toBe(100);
  });

  it('caps completed parts by plan when planned count exists', () => {
    const sections: ContractSections = {
      primary: {
        number: 'K-1',
        signedAt: null,
        dueAt: null,
        internalNumber: '',
        customerId: null,
        engineBrands: [{ engineBrandId: 'b-1', qty: 2, unitPrice: 0 }],
        parts: [],
      },
      addons: [],
    };
    const result = aggregateContractExecutionProgress({
      sections,
      engineItems: [
        { statusFlags: { status_customer_accepted: true } },
        { statusFlags: { status_repair_started: true } },
      ],
      executionParts: [{ partId: 'p-1', plannedQty: 2, completedQty: 7 }],
    });
    expect(result.enginePlannedCount).toBe(2);
    expect(result.engineAcceptedCount).toBe(1);
    expect(result.partPlannedCount).toBe(2);
    expect(result.partCompletedCount).toBe(2);
    expect(result.rawPartCompletedCount).toBe(7);
    expect(result.totalCount).toBe(4);
    expect(result.completedCount).toBe(3);
    expect(result.progressPct).toBe(75);
  });

  it('uses fallback denominator when no plan is provided', () => {
    const result = aggregateContractExecutionProgress({
      sections: null,
      engineItems: [{ statusFlags: { status_customer_accepted: true } }],
      executionParts: [{ partId: 'p-1', plannedQty: 0, completedQty: 3 }],
    });
    expect(result.totalCount).toBe(4);
    expect(result.completedCount).toBe(4);
    expect(result.progressPct).toBe(100);
  });

  it('linear schedule expected progress is halfway at midpoint', () => {
    const signedAt = 1_000_000;
    const dueAt = signedAt + 100 * 24 * 60 * 60 * 1000;
    const mid = signedAt + 50 * 24 * 60 * 60 * 1000;
    expect(linearScheduleExpectedProgressPct({ signedAt, dueAt, now: signedAt })).toBe(0);
    expect(linearScheduleExpectedProgressPct({ signedAt, dueAt, now: mid })).toBe(50);
    expect(linearScheduleExpectedProgressPct({ signedAt, dueAt, now: dueAt })).toBe(100);
  });

  it('detects lag when actual is far below expected linear progress', () => {
    const signedAt = 1_000_000;
    const dueAt = signedAt + 100 * 24 * 60 * 60 * 1000;
    const now = signedAt + 50 * 24 * 60 * 60 * 1000;
    expect(isContractLaggingVsSchedule({ actualProgressPct: 20, signedAt, dueAt, now, minGapPct: 10 })).toBe(true);
    expect(isContractLaggingVsSchedule({ actualProgressPct: 45, signedAt, dueAt, now, minGapPct: 10 })).toBe(false);
  });

  it('treats overdue contracts as lagging until nearly complete', () => {
    const dueAt = 1_000_000;
    const now = dueAt + 24 * 60 * 60 * 1000;
    expect(isContractLaggingVsSchedule({ actualProgressPct: 50, signedAt: null, dueAt, now })).toBe(true);
    expect(isContractLaggingVsSchedule({ actualProgressPct: 100, signedAt: null, dueAt, now })).toBe(false);
  });

  it('sumEngineBrandQtyByBrandFromContractSections sums primary and addons by brand', () => {
    const sections: ContractSections = {
      primary: {
        number: 'K-1',
        signedAt: null,
        dueAt: null,
        internalNumber: '',
        customerId: null,
        engineBrands: [
          { engineBrandId: 'brand-a', qty: 2, unitPrice: 0 },
          { engineBrandId: 'brand-b', qty: 1, unitPrice: 0 },
        ],
        parts: [],
      },
      addons: [
        {
          number: 'DS-1',
          signedAt: null,
          dueAt: null,
          note: '',
          engineBrands: [
            { engineBrandId: 'brand-a', qty: 3, unitPrice: 0 },
            { engineBrandId: 'brand-c', qty: 0, unitPrice: 0 },
          ],
          parts: [],
        },
      ],
    };
    const m = sumEngineBrandQtyByBrandFromContractSections(sections);
    expect(m.get('brand-a')).toBe(5);
    expect(m.get('brand-b')).toBe(1);
    expect(m.has('brand-c')).toBe(false);
  });
});

describe('contract attribute parsers tolerate malformed input', () => {
  const badInputs: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['string', 'not-an-object'],
    ['array', []],
  ];

  for (const [label, value] of badInputs) {
    it(`parseContractExecutionParts returns [] for ${label}`, () => {
      expect(parseContractExecutionParts(value as Record<string, unknown>)).toEqual([]);
    });

    it(`parseContractSections returns empty default for ${label}`, () => {
      const sections = parseContractSections(value as Record<string, unknown>);
      expect(sections.primary.parts).toEqual([]);
      expect(sections.addons).toEqual([]);
      expect(sections.primary.number).toBe('');
    });
  }

  it('parseContractExecutionParts reads rows from the full attributes object', () => {
    const rows = parseContractExecutionParts({
      contract_execution_parts: [{ partId: 'p-1', plannedQty: 2, completedQty: 1 }],
    });
    expect(rows).toEqual([{ partId: 'p-1', plannedQty: 2, completedQty: 1 }]);
  });

  it('parseContractExecutionParts returns [] when the attribute is absent', () => {
    expect(parseContractExecutionParts({ contract_sections: {} })).toEqual([]);
  });

  it('parseContractSections reads parts from the full attributes object', () => {
    const sections = parseContractSections({
      contract_sections: {
        primary: { number: 'K-1', parts: [{ partId: 'p-1', qty: 1, unitPrice: 0 }] },
        addons: [],
      },
    });
    expect(sections.primary.number).toBe('K-1');
    expect(sections.primary.parts).toEqual([{ partId: 'p-1', qty: 1, unitPrice: 0 }]);
  });
});

describe('engine contract binding classification', () => {
  it('detects ДС tokens but not primary contract numbers', () => {
    expect(isContractAddonToken('ДС 1')).toBe(true);
    expect(isContractAddonToken('ДС 12')).toBe(true);
    expect(isContractAddonToken('  ДС 3  ')).toBe(true);
    expect(isContractAddonToken('K-2024/15')).toBe(false);
    expect(isContractAddonToken('')).toBe(false);
    expect(isContractAddonToken(null)).toBe(false);
    expect(isContractAddonToken('ДСП-1')).toBe(false); // не «ДС <пробел>»
  });

  it('classifies none / contract / addon', () => {
    expect(classifyEngineContractBinding({ contractId: '', contractSectionNumber: '' })).toBe('none');
    expect(classifyEngineContractBinding({ contractId: null, contractSectionNumber: 'ДС 1' })).toBe('none');
    expect(classifyEngineContractBinding({ contractId: 'c-1', contractSectionNumber: '' })).toBe('contract');
    expect(classifyEngineContractBinding({ contractId: 'c-1', contractSectionNumber: 'K-2024/15' })).toBe('contract');
    expect(classifyEngineContractBinding({ contractId: 'c-1', contractSectionNumber: 'ДС 2' })).toBe('addon');
  });
});


describe('canonical contract section key', () => {
  it('keeps ДС tokens as they are', () => {
    expect(canonicalContractSectionKey('ДС 3')).toBe('ДС 3');
    expect(canonicalContractSectionKey('  ДС 12  ')).toBe('ДС 12');
  });

  it('maps a legacy contract number to the stable primary key', () => {
    // Так лежит на проде до миграции: ключом основного договора был его номер.
    expect(canonicalContractSectionKey('2325187912611432245222883/739-1/71ОВК/12-23/29/ГОЗ-24')).toBe('primary');
    expect(canonicalContractSectionKey('K-2024/15')).toBe('primary');
  });

  it('rescues a key orphaned by an earlier number edit', () => {
    // Номер уже сменили, сохранённая строка ни с чем не совпадает — но другой секции
    // у неё быть не могло, значит это основной договор.
    expect(canonicalContractSectionKey('K-2024/15-старый')).toBe('primary');
  });

  it('is idempotent and keeps "no binding" empty', () => {
    expect(canonicalContractSectionKey('primary')).toBe('primary');
    expect(canonicalContractSectionKey(canonicalContractSectionKey('K-2024/15'))).toBe('primary');
    expect(canonicalContractSectionKey('')).toBe('');
    expect(canonicalContractSectionKey('   ')).toBe('');
    expect(canonicalContractSectionKey(null)).toBe('');
    expect(canonicalContractSectionKey(undefined)).toBe('');
  });

  it('option id of the primary section no longer depends on the editable number', () => {
    const sections = parseContractSections({
      contract_sections: {
        primary: { number: 'K-2024/15', signedAt: null, dueAt: null, engineBrands: [] },
        addons: [],
      },
    });
    const before = buildContractSectionOptions(sections);
    const renamed = { ...sections, primary: { ...sections.primary, number: 'K-2024/15-1' } };
    const after = buildContractSectionOptions(renamed);
    expect(before[0]?.id).toBe('primary');
    expect(after[0]?.id).toBe(before[0]?.id);
    // Показываем оператору по-прежнему номер — меняется подпись, а не ключ.
    expect(after[0]?.label).toBe('Договор K-2024/15-1');
  });

  it('offers the primary section even before the number is filled in', () => {
    const sections = parseContractSections({
      contract_sections: { primary: { number: '', signedAt: null, dueAt: null, engineBrands: [] }, addons: [] },
    });
    const options = buildContractSectionOptions(sections);
    expect(options[0]).toMatchObject({ id: 'primary', isPrimary: true, label: 'Основной договор' });
  });
});
