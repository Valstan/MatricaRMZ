import { describe, expect, it } from 'vitest';

import { aggregateContractExecutionProgress, computeObjectProgress, type ContractSections } from './contract.js';

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
});

