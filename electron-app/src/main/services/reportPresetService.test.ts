import { describe, expect, it } from 'vitest';

import { __reportPresetTestUtils } from './reportPresetService.js';

describe('reportPresetService work order helpers', () => {
  it('normalizes work-order lines from grouped, free and legacy payloads', () => {
    const grouped = __reportPresetTestUtils.normalizeWorkOrderReportLines({
      workGroups: [{ lines: [{ serviceName: 'Работа A', qty: 2, amountRub: 100 }] }],
      freeWorks: [{ serviceName: 'Работа B', qty: 1, amountRub: 50 }],
    });
    expect(grouped).toEqual([
      { serviceName: 'Работа A', qty: 2, amountRub: 100 },
      { serviceName: 'Работа B', qty: 1, amountRub: 50 },
    ]);

    const legacy = __reportPresetTestUtils.normalizeWorkOrderReportLines({
      works: [{ serviceName: 'Legacy', qty: 3, amountRub: 210 }],
    });
    expect(legacy).toEqual([{ serviceName: 'Legacy', qty: 3, amountRub: 210 }]);

    const fallback = __reportPresetTestUtils.normalizeWorkOrderReportLines({
      partName: 'Без строк',
      totalAmountRub: 77,
    });
    expect(fallback).toEqual([{ serviceName: 'Без строк', qty: 1, amountRub: 77 }]);
  });

  it('normalizes crew and respects frozen payout with manual value', () => {
    const crew = __reportPresetTestUtils.normalizeWorkOrderReportCrew({
      crew: [
        { employeeId: 'e-1', employeeName: 'Иванов И.И.', ktu: 1.2, payoutFrozen: true, manualPayoutRub: 1234.56 },
        { employeeId: 'e-2', employeeName: 'Петров П.П.', ktu: 0.8, payoutRub: 789.01 },
      ],
      payouts: [{ employeeId: 'e-1', employeeName: 'Иванов И.И.', ktu: 1.2, amountRub: 999 }],
    });

    expect(crew).toHaveLength(2);
    expect(crew[0]).toMatchObject({ employeeId: 'e-1', payoutRub: 1234.56, ktu: 1.2 });
    expect(crew[1]).toMatchObject({ employeeId: 'e-2', payoutRub: 789.01, ktu: 0.8 });
  });

  it('resolves work-order target label from partName and grouped names', () => {
    expect(__reportPresetTestUtils.resolveWorkOrderTargetLabel({ partName: 'Двигатель 1' })).toBe('Двигатель 1');
    expect(
      __reportPresetTestUtils.resolveWorkOrderTargetLabel({
        workGroups: [{ partName: 'Изделие A' }, { partName: 'Изделие B' }, { partName: 'Изделие A' }],
      }),
    ).toBe('Изделие A, Изделие B');
  });
});
