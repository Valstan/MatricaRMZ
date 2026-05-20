import { describe, expect, it } from 'vitest';

import { normalizeWorkOrderLine } from './workOrder.js';

describe('normalizeWorkOrderLine', () => {
  it('preserves product number and engine linkage fields', () => {
    const line = normalizeWorkOrderLine(
      {
        serviceId: 'svc-1',
        serviceName: 'Сборка',
        unit: 'шт',
        qty: 2,
        priceRub: 50,
        productNumber: 'Д-42',
        engineId: 'eng-1',
        engineNumber: '12345',
        engineBrandId: 'brand-1',
        engineBrandName: 'М-240',
      },
      1,
    );

    expect(line.productNumber).toBe('Д-42');
    expect(line.engineId).toBe('eng-1');
    expect(line.engineNumber).toBe('12345');
    expect(line.engineBrandId).toBe('brand-1');
    expect(line.engineBrandName).toBe('М-240');
    expect(line.amountRub).toBe(100);
  });

  it('omits empty product number and engine fields', () => {
    const line = normalizeWorkOrderLine(
      {
        serviceName: 'Работа',
        unit: 'шт',
        qty: 1,
        priceRub: 10,
        productNumber: '   ',
        engineId: null,
      },
      2,
    );

    expect(line.productNumber).toBeUndefined();
    expect(line.engineId).toBeUndefined();
    expect(line.engineNumber).toBeUndefined();
    expect(line.partId).toBeUndefined();
    expect(line.partName).toBeUndefined();
  });

  it('preserves part selection fields', () => {
    const line = normalizeWorkOrderLine(
      {
        serviceName: 'Сборка',
        unit: 'шт',
        qty: 1,
        priceRub: 100,
        partId: 'part-1',
        partName: 'Гильза 1Ч-12',
      },
      3,
    );

    expect(line.partId).toBe('part-1');
    expect(line.partName).toBe('Гильза 1Ч-12');
  });

  it('omits partName when partId is missing', () => {
    const line = normalizeWorkOrderLine(
      {
        serviceName: 'Работа',
        unit: 'шт',
        qty: 1,
        priceRub: 10,
        partId: '',
        partName: 'Лишнее имя',
      },
      4,
    );

    expect(line.partId).toBeUndefined();
    expect(line.partName).toBeUndefined();
  });
});
