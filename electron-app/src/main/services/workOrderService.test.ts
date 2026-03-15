import { describe, expect, it } from 'vitest';

import { __workOrderTestUtils } from './workOrderService.js';

describe('workOrderService calculations', () => {
  it('recalculates totals and honors frozen payouts', () => {
    const payload = __workOrderTestUtils.recalcPayload({
      kind: 'work_order',
      version: 2,
      operationId: 'wo-1',
      workOrderNumber: 7,
      orderDate: 1700000000000,
      crew: [
        { employeeId: 'e-1', employeeName: 'Сотрудник 1', ktu: 1, payoutFrozen: true, manualPayoutRub: 20 },
        { employeeId: 'e-2', employeeName: 'Сотрудник 2', ktu: 2, payoutFrozen: false },
      ],
      workGroups: [
        {
          groupId: 'g-1',
          partId: 'part-1',
          partName: 'Изделие 1',
          lines: [
            { lineNo: 1, serviceId: 's-1', serviceName: 'Работа 1', unit: 'шт', qty: 2, priceRub: 50, amountRub: 0 },
            { lineNo: 2, serviceId: 's-2', serviceName: 'Работа 2', unit: 'шт', qty: 1, priceRub: 50, amountRub: 0 },
          ],
        },
      ],
      freeWorks: [],
      works: [],
      totalAmountRub: 0,
      basePerWorkerRub: 0,
      payouts: [],
    } as any);

    expect(payload.totalAmountRub).toBe(150);
    expect(payload.crew[0]?.payoutRub).toBe(20);
    expect(payload.crew[1]?.payoutRub).toBe(130);
    expect(payload.payouts.reduce((acc, row) => acc + row.amountRub, 0)).toBe(150);
  });

  it('extracts unique part names from v2 and legacy payloads', () => {
    const partNames = __workOrderTestUtils.getWorkOrderPartNames({
      kind: 'work_order',
      version: 2,
      operationId: 'wo-2',
      workOrderNumber: 8,
      orderDate: 1700000000000,
      crew: [],
      workGroups: [
        { groupId: 'g-1', partId: 'p-1', partName: 'Изделие A', lines: [] },
        { groupId: 'g-2', partId: 'p-2', partName: 'Изделие B', lines: [] },
        { groupId: 'g-3', partId: 'p-3', partName: 'Изделие A', lines: [] },
      ],
      freeWorks: [],
      works: [],
      totalAmountRub: 0,
      basePerWorkerRub: 0,
      payouts: [],
    });
    expect(partNames).toEqual(['Изделие A', 'Изделие B']);

    const legacyNames = __workOrderTestUtils.getWorkOrderPartNames({
      kind: 'work_order',
      version: 2,
      operationId: 'wo-3',
      workOrderNumber: 9,
      orderDate: 1700000000000,
      crew: [],
      workGroups: [],
      freeWorks: [],
      works: [],
      totalAmountRub: 0,
      basePerWorkerRub: 0,
      payouts: [],
      partName: 'Legacy изделие',
    } as any);
    expect(legacyNames).toEqual(['Legacy изделие']);
  });

  it('normalizes invalid line values', () => {
    const line = __workOrderTestUtils.normalizeLine(
      {
        qty: -3,
        priceRub: -400,
        serviceName: null,
        unit: null,
      },
      1,
    );

    expect(line.qty).toBe(0);
    expect(line.priceRub).toBe(0);
    expect(line.amountRub).toBe(0);
    expect(line.serviceName).toBe('');
    expect(line.unit).toBe('');
  });
});
