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

  it('requiredComponentsSummary включает подпись склада при warehouseStockBins', () => {
    const stock = new Map<string, number>([
      ['p1', 20],
      ['p2', 20],
    ]);
    const warehouseStockBins = new Map([
      ['p1', [{ warehouseId: 'w1', warehouseLabel: 'Склад цеха', qty: 20 }]],
      ['p2', [{ warehouseId: 'w1', warehouseLabel: 'Склад цеха', qty: 20 }]],
    ]);
    const kits = mergeBrandKits([
      { partId: 'p1', brandId: 'b1', brandLabel: 'B1', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p2', brandId: 'b1', brandLabel: 'B1', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 2,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      warehouseStockBins,
      incomingLines: [],
    });
    const row = res.rows.find((r) => r.engineBrand === 'B1' && r.plannedEngines > 0);
    expect(row?.requiredComponentsSummary).toContain('Склад цеха');
    expect(row?.requiredComponentsSummary?.includes('\n')).toBe(true);
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
    const gap = res.rows.filter((r) => r.status === 'shortage' || r.status === 'absent');
    expect(gap.length).toBeGreaterThan(0);
    expect(gap[0]?.plannedEngines).toBe(5);
    expect(gap[0]?.status).toBe('shortage');
    expect(gap[0]?.requiredComponentsSummary).toMatch(/настройкам|Номинальный расход/);
  });

  it('shortage row gives a narrow plan scenario (1–2 base brands), not every BOM variant', () => {
    const stock = new Map<string, number>([
      ['g1', 0],
      ['p1', 0],
      ['g2', 0],
      ['p2', 0],
    ]);
    const base46 = '11111111-1111-1111-1111-111111111146';
    const base59 = '22222222-2222-2222-2222-222222222259';
    const kits = mergeBrandKits([
      { partId: 'g1', brandId: `${base46}::v1`, brandLabel: 'В-46 (вариант 1)', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p1', brandId: `${base46}::v1`, brandLabel: 'В-46 (вариант 1)', partName: 'Поршень', article: '', qtyPerEngine: 1 },
      { partId: 'g1', brandId: `${base46}::v2`, brandLabel: 'В-46 (вариант 2)', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p1', brandId: `${base46}::v2`, brandLabel: 'В-46 (вариант 2)', partName: 'Поршень', article: '', qtyPerEngine: 1 },
      { partId: 'g2', brandId: `${base59}::v1`, brandLabel: 'В-59 (вариант 1)', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p2', brandId: `${base59}::v1`, brandLabel: 'В-59 (вариант 1)', partName: 'Поршень', article: '', qtyPerEngine: 1 },
      { partId: 'g2', brandId: `${base59}::v2`, brandLabel: 'В-59 (вариант 2)', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p2', brandId: `${base59}::v2`, brandLabel: 'В-59 (вариант 2)', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 2,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
      priorityEngineBrandIds: [base59, base46],
    });
    const gap = res.rows.filter((r) => r.status === 'shortage' || r.status === 'absent');
    expect(gap.length).toBeGreaterThan(0);
    expect(gap[0]?.status).toBe('absent');
    expect(gap[0]?.plannedEngines).toBe(2);
    const eb = gap[0]?.engineBrand ?? '';
    expect(eb).toMatch(/Цель 2 двиг\.\/сутки/);
    expect(eb).toContain('Не закрыто');
    expect(eb).toContain('Ориентир по плану:');
    expect(eb).toContain('В-59 (вариант 1)');
    expect(eb).toContain('В-46 (вариант 1)');
    expect(eb).not.toContain('возможны марки');
    expect(eb).not.toContain('вариант 2)');
    const summary = gap[0]?.requiredComponentsSummary ?? '';
    expect(summary).toContain('остальные варианты BOM не перечисляем');
    expect(summary.match(/В-59 \(вариант/g)?.length).toBe(1);
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

  it('formats day label with date and weekday', () => {
    const stock = new Map<string, number>([
      ['p1', 4],
      ['p2', 4],
    ]);
    const kits = mergeBrandKits([
      { partId: 'p1', brandId: 'b1', brandLabel: 'B1', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p2', brandId: 'b1', brandLabel: 'B1', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 1,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
    });
    expect(res.rows[0]?.dayLabel ?? '').toMatch(/^\d{2}\.\d{2}\.\d{4} \([а-я]+\)$/);
  });

  it('skips assembly on non-working weekdays and emits weekend row', () => {
    const stock = new Map<string, number>([
      ['p1', 100],
      ['p2', 100],
    ]);
    const kits = mergeBrandKits([
      { partId: 'p1', brandId: 'b1', brandLabel: 'B1', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p2', brandId: 'b1', brandLabel: 'B1', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const todayDow = new Date(new Date().setHours(0, 0, 0, 0)).getDay();
    const nonTodayDow = (todayDow + 1) % 7;
    const res = computeAssemblyForecast({
      horizonDays: 1,
      targetEnginesPerDay: 3,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
      workingWeekdays: [nonTodayDow],
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.status).toBe('weekend');
    expect(res.rows[0]?.engineBrand).toBe('Выходной');
    expect(res.rows[0]?.plannedEngines).toBe(0);
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
    expect(day0.some((r) => r.status === 'shortage' || r.status === 'absent')).toBe(true);
    const plannedD1 = day1.filter((r) => r.engineBrand === 'B1').reduce((a, r) => a + r.plannedEngines, 0);
    expect(plannedD1).toBe(2);
  });

  it('virtually depletes abundant stock across horizon when daily target is only partly met', () => {
    const stock = new Map<string, number>([
      ['p1', 100],
      ['p2', 2],
    ]);
    const kits = mergeBrandKits([
      { partId: 'p1', brandId: 'b1', brandLabel: 'B1', partName: 'Гильза', article: '', qtyPerEngine: 1 },
      { partId: 'p2', brandId: 'b1', brandLabel: 'B1', partName: 'Поршень', article: '', qtyPerEngine: 1 },
    ]);
    const res = computeAssemblyForecast({
      horizonDays: 2,
      targetEnginesPerDay: 3,
      sameBrandBatchSize: 2,
      warehouseId: null,
      kits,
      stockByNomenclatureId: stock,
      incomingLines: [],
    });
    const day0Gap = res.rows.filter((r) => r.dayOffset === 0 && (r.status === 'shortage' || r.status === 'absent'));
    const day1Gap = res.rows.filter((r) => r.dayOffset === 1 && (r.status === 'shortage' || r.status === 'absent'));
    expect(day0Gap.length).toBeGreaterThan(0);
    expect(day1Gap.length).toBeGreaterThan(0);
    const s0 = day0Gap[0]!.requiredComponentsSummary ?? '';
    const s1 = day1Gap[0]!.requiredComponentsSummary ?? '';
    const m0 = s0.match(/Гильза: на складах после учёта дня (\d+) шт\./);
    const m1 = s1.match(/Гильза: на складах после учёта дня (\d+) шт\./);
    expect(m0?.[1]).toBeTruthy();
    expect(m1?.[1]).toBeTruthy();
    expect(Number(m1![1])).toBeLessThan(Number(m0![1]));
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
    expect(res.horizonMissingByBrand).toEqual([]);
    expect(res.horizonComponentNeeds).toEqual([]);
  });

  it('returns horizon deficit by brands and component needs', () => {
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
    const gapBrandA = res.horizonMissingByBrand.find((x) => x.brandLabel === 'Brand A');
    expect(gapBrandA?.missingEngines).toBe(5);
    const needs = res.horizonComponentNeeds;
    expect(needs.length).toBeGreaterThan(0);
    expect(needs.some((n) => n.requiredQty >= 1 && n.forBrands.includes('Brand A'))).toBe(true);
  });
});
