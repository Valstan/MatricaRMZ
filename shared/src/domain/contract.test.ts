import { describe, expect, it } from 'vitest';

import {
  aggregateContractExecutionProgress,
  computeObjectProgress,
  isContractLaggingVsSchedule,
  linearScheduleExpectedProgressPct,
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

