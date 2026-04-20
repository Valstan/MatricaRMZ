import { describe, expect, it } from 'vitest';

import {
  computeAssemblyForecast,
  mergeBrandKits,
  parseAssemblyIncomingPlanJson,
} from './assemblyForecast.js';

describe('assemblyForecast', () => {
  it('mergeBrandKits merges duplicate part+brand rows by max qty', () => {
    const kits = mergeBrandKits([
      { partId: 'p1', brandId: 'b1', brandLabel: 'Brand', partName: 'Гильза A', article: 'G-1', qtyPerEngine: 1 },
      { partId: 'p1', brandId: 'b1', brandLabel: 'Brand', partName: 'Гильза A', article: 'G-1', qtyPerEngine: 2 },
    ]);
    expect(kits).toHaveLength(1);
    expect(kits[0]?.parts.find((p) => p.partId === 'p1')?.qtyPerEngine).toBe(2);
  });

  it('computeAssemblyForecast allocates up to target when stock allows', () => {
    const stock = new Map<string, number>([
      ['p1', 10],
      ['p2', 10],
    ]);
    const kits = mergeBrandKits([
      { partId: 'p1', brandId: 'b1', brandLabel: 'B1', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p2', brandId: 'b1', brandLabel: 'B1', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 4,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
    });
    const planned = res.rows.filter((r) => r.engineBrand === 'B1').reduce((a, r) => a + r.plannedEngines, 0);
    expect(planned).toBe(4);
  });

  it('emits shortage row when stock cannot satisfy target', () => {
    const stock = new Map<string, number>([
      ['p1', 1],
      ['p2', 1],
    ]);
    const kits = mergeBrandKits([
      { partId: 'p1', brandId: 'b1', brandLabel: 'B1', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p2', brandId: 'b1', brandLabel: 'B1', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 5,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
    });
    const shortage = res.rows.filter((r) => r.status === 'shortage');
    expect(shortage.length).toBeGreaterThan(0);
    expect(shortage[0]?.plannedEngines).toBe(0);
    expect(shortage[0]?.deficitsSummary).toMatch(/Не удалось набрать/);
  });

  it('allocates priority brands before others when priorityEngineBrandIds is set', () => {
    const stock = new Map<string, number>([
      ['a1', 2],
      ['a2', 2],
      ['b1', 10],
      ['b2', 10],
    ]);
    const kits = mergeBrandKits([
      { partId: 'a1', brandId: 'ba', brandLabel: 'Pri A', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'a2', brandId: 'ba', brandLabel: 'Pri A', partName: 'Поршень', article: '', qtyPerEngine: 1 },
      { partId: 'b1', brandId: 'bb', brandLabel: 'Other B', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'b2', brandId: 'bb', brandLabel: 'Other B', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 3,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
      priorityEngineBrandIds: ['ba'],
    });
    const pri = res.rows.filter((r) => r.engineBrand === 'Pri A').reduce((a, r) => a + r.plannedEngines, 0);
    const oth = res.rows.filter((r) => r.engineBrand === 'Other B').reduce((a, r) => a + r.plannedEngines, 0);
    expect(pri).toBe(2);
    expect(oth).toBe(1);
  });

  it('round-robin shares daily target across multiple brands when stock allows', () => {
    const stock = new Map<string, number>([
      ['a1', 14],
      ['a2', 14],
      ['b1', 14],
      ['b2', 14],
    ]);
    const kits = mergeBrandKits([
      { partId: 'a1', brandId: 'ba', brandLabel: 'Brand A', partName: 'Гильза', article: 'A1', qtyPerEngine: 1 },
      { partId: 'a2', brandId: 'ba', brandLabel: 'Brand A', partName: 'Поршень', article: 'A2', qtyPerEngine: 1 },
      { partId: 'b1', brandId: 'bb', brandLabel: 'Brand B', partName: 'Гильза', article: 'B1', qtyPerEngine: 1 },
      { partId: 'b2', brandId: 'bb', brandLabel: 'Brand B', partName: 'Поршень', article: 'B2', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 15,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
    });
    const plannedA = res.rows.filter((r) => r.engineBrand === 'Brand A').reduce((a, r) => a + r.plannedEngines, 0);
    const plannedB = res.rows.filter((r) => r.engineBrand === 'Brand B').reduce((a, r) => a + r.plannedEngines, 0);
    expect(plannedA + plannedB).toBe(15);
    expect(plannedA).toBeGreaterThan(0);
    expect(plannedB).toBeGreaterThan(0);
    expect(Math.abs(plannedA - plannedB)).toBeLessThanOrEqual(1);
  });

  it('prefers same-brand batches when sameBrandBatchSize is set', () => {
    const stock = new Map<string, number>([
      ['a1', 20],
      ['a2', 20],
      ['b1', 20],
      ['b2', 20],
    ]);
    const kits = mergeBrandKits([
      { partId: 'a1', brandId: 'ba', brandLabel: 'Brand A', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'a2', brandId: 'ba', brandLabel: 'Brand A', partName: 'Поршень', article: '', qtyPerEngine: 1 },
      { partId: 'b1', brandId: 'bb', brandLabel: 'Brand B', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'b2', brandId: 'bb', brandLabel: 'Brand B', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 8,
      sameBrandBatchSize: 4,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
    });
    const plannedA = res.rows.filter((r) => r.engineBrand === 'Brand A').reduce((a, r) => a + r.plannedEngines, 0);
    const plannedB = res.rows.filter((r) => r.engineBrand === 'Brand B').reduce((a, r) => a + r.plannedEngines, 0);
    expect(plannedA).toBe(4);
    expect(plannedB).toBe(4);
  });

  it('moves to next brand if full same-brand batch is impossible and keeps that start on next day', () => {
    const stock = new Map<string, number>([
      ['a1', 3],
      ['a2', 3],
      ['b1', 5],
      ['b2', 5],
    ]);
    const kits = mergeBrandKits([
      { partId: 'a1', brandId: 'ba', brandLabel: 'Brand A', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'a2', brandId: 'ba', brandLabel: 'Brand A', partName: 'Поршень', article: '', qtyPerEngine: 1 },
      { partId: 'b1', brandId: 'bb', brandLabel: 'Brand B', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'b2', brandId: 'bb', brandLabel: 'Brand B', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 2,
      targetEnginesPerDay: 4,
      sameBrandBatchSize: 4,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
    });
    const day1A = res.rows.filter((r) => r.dayOffset === 0 && r.engineBrand === 'Brand A').reduce((a, r) => a + r.plannedEngines, 0);
    const day1B = res.rows.filter((r) => r.dayOffset === 0 && r.engineBrand === 'Brand B').reduce((a, r) => a + r.plannedEngines, 0);
    const day2B = res.rows.filter((r) => r.dayOffset === 1 && r.engineBrand === 'Brand B').reduce((a, r) => a + r.plannedEngines, 0);
    expect(day1A).toBe(3);
    expect(day1B).toBe(1);
    expect(day2B).toBe(4);
  });

  it('applies incoming plan from a later day before that day allocation', () => {
    const stock = new Map<string, number>([
      ['p1', 0],
      ['p2', 0],
    ]);
    const kits = mergeBrandKits([
      { partId: 'p1', brandId: 'b1', brandLabel: 'B1', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p2', brandId: 'b1', brandLabel: 'B1', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 2,
      targetEnginesPerDay: 2,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [
        { dayOffset: 1, nomenclatureId: 'p1', qty: 5 },
        { dayOffset: 1, nomenclatureId: 'p2', qty: 5 },
      ],
    });
    const day0 = res.rows.filter((r) => r.dayOffset === 0);
    const day1 = res.rows.filter((r) => r.dayOffset === 1);
    expect(day0.some((r) => r.status === 'shortage')).toBe(true);
    const plannedD1 = day1.filter((r) => r.engineBrand === 'B1').reduce((a, r) => a + r.plannedEngines, 0);
    expect(plannedD1).toBe(2);
  });

  it('is deterministic for identical inputs', () => {
    const stock = new Map<string, number>([
      ['x1', 8],
      ['x2', 8],
      ['y1', 8],
      ['y2', 8],
    ]);
    const kits = mergeBrandKits([
      { partId: 'x1', brandId: 'z1', brandLabel: 'Zebra', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'x2', brandId: 'z1', brandLabel: 'Zebra', partName: 'Поршень', article: '', qtyPerEngine: 1 },
      { partId: 'y1', brandId: 'z2', brandLabel: 'Якорь', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'y2', brandId: 'z2', brandLabel: 'Якорь', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const input = {
      horizonDays: 3,
      targetEnginesPerDay: 3,
      warehouseId: null as string | null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [] as const,
    };
    const a = computeAssemblyForecast({ ...input, incomingLines: [] });
    const b = computeAssemblyForecast({ ...input, incomingLines: [] });
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
    expect(JSON.stringify(a.warnings)).toBe(JSON.stringify(b.warnings));
  });

  it('parseAssemblyIncomingPlanJson accepts JSON string and partId alias', () => {
    const raw = JSON.stringify([
      { dayOffset: 2, partId: 'n1', qty: 3 },
      { dayOffset: 0, nomenclatureId: 'n2', qty: 0 },
    ]);
    const lines = parseAssemblyIncomingPlanJson(raw);
    expect(lines).toEqual([{ dayOffset: 2, nomenclatureId: 'n1', qty: 3 }]);
  });

  it('warns when no kits after filtering', () => {
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 1,
      warehouseId: null,
      kits: [],
      stockByNomenclatureId: new Map(),
      incomingLines: [],
    });
    expect(res.warnings.some((w) => w.includes('Нет комплектов'))).toBe(true);
  });
});
