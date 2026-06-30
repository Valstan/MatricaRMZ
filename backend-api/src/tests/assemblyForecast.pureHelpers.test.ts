import { describe, expect, it } from 'vitest';

import {
  baseEngineBrandIdFromKitBrandId,
  buildAssemblyForecastVariantKey,
  inferAssemblyComponentRole,
  parseAssemblyIncomingPlanJson,
} from '@matricarmz/shared';

// Pure-функции прогноза сборки — без mocks, без БД/drizzle/сети.
// Закрывают мелкий техдолг по тест-покрытию доменных хелперов assemblyForecast.ts.

describe('buildAssemblyForecastVariantKey', () => {
  const base = { dayOffset: 1, brandId: 'B1', engineIndex: 0 };
  const p = (partId: string, qty: number) => ({ partId, qty, partLabel: partId });

  it('детерминированно сортирует детали по partId — порядок входа не влияет на ключ', () => {
    const k1 = buildAssemblyForecastVariantKey({ ...base, parts: [p('p2', 1), p('p1', 2)] });
    const k2 = buildAssemblyForecastVariantKey({ ...base, parts: [p('p1', 2), p('p2', 1)] });
    expect(k1).toBe(k2);
    expect(k1).toBe('assembly:1:B1:0:p1:2,p2:1');
  });

  it('отбрасывает строки с qty<=0 или пустым partId и округляет qty вниз', () => {
    const key = buildAssemblyForecastVariantKey({ ...base, parts: [p('p1', 2.9), p('p2', 0), p('', 5)] });
    expect(key).toBe('assembly:1:B1:0:p1:2');
  });

  it('пустой набор деталей даёт ключ с пустым хвостом', () => {
    expect(buildAssemblyForecastVariantKey({ ...base, parts: [] })).toBe('assembly:1:B1:0:');
  });

  it('dayOffset и engineIndex входят в ключ (разные значения → разные ключи)', () => {
    const a = buildAssemblyForecastVariantKey({ dayOffset: 1, brandId: 'B', engineIndex: 0, parts: [p('p', 1)] });
    const b = buildAssemblyForecastVariantKey({ dayOffset: 2, brandId: 'B', engineIndex: 0, parts: [p('p', 1)] });
    const c = buildAssemblyForecastVariantKey({ dayOffset: 1, brandId: 'B', engineIndex: 1, parts: [p('p', 1)] });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('inferAssemblyComponentRole', () => {
  it('классифицирует по русским ключевым словам', () => {
    expect(inferAssemblyComponentRole('Гильза цилиндра', '')).toBe('sleeve');
    expect(inferAssemblyComponentRole('Поршень', '')).toBe('piston');
    expect(inferAssemblyComponentRole('Кольцо уплотнительное', '')).toBe('rings');
    expect(inferAssemblyComponentRole('Рубашка блока', '')).toBe('jacket');
    expect(inferAssemblyComponentRole('Картер нижний', '')).toBe('jacket');
    expect(inferAssemblyComponentRole('Головка блока', '')).toBe('head');
  });

  // Документированный нюанс приоритета: piston-проверка (`порш`) идёт ДО rings-проверки,
  // поэтому «Кольцо поршневое» классифицируется как piston, а не rings (см. порядок в коде).
  it('приоритет piston над rings: «Кольцо поршневое» → piston (по совпадению «порш»)', () => {
    expect(inferAssemblyComponentRole('Кольцо поршневое', '')).toBe('piston');
  });

  it('классифицирует по английским ключевым словам и регистронезависимо', () => {
    expect(inferAssemblyComponentRole('Cylinder LINER', '')).toBe('sleeve');
    expect(inferAssemblyComponentRole('PISTON assembly', '')).toBe('piston');
    expect(inferAssemblyComponentRole('Compression Ring', '')).toBe('rings');
  });

  it('учитывает артикул, а не только наименование', () => {
    expect(inferAssemblyComponentRole('Деталь', 'ГИЛЬЗА-303')).toBe('sleeve');
  });

  it('неизвестное → other', () => {
    expect(inferAssemblyComponentRole('Болт крепёжный', 'M10x40')).toBe('other');
    expect(inferAssemblyComponentRole('', '')).toBe('other');
  });
});

describe('baseEngineBrandIdFromKitBrandId', () => {
  it('возвращает префикс до «::» для kit-составного id', () => {
    expect(baseEngineBrandIdFromKitBrandId('brand-1::variant-7')).toBe('brand-1');
  });

  it('возвращает id целиком, если разделителя нет', () => {
    expect(baseEngineBrandIdFromKitBrandId('brand-1')).toBe('brand-1');
  });

  it('тримит и переживает пустые/невалидные значения', () => {
    expect(baseEngineBrandIdFromKitBrandId('  brand-1::v  ')).toBe('brand-1');
    expect(baseEngineBrandIdFromKitBrandId('')).toBe('');
    expect(baseEngineBrandIdFromKitBrandId(undefined as unknown as string)).toBe('');
    expect(baseEngineBrandIdFromKitBrandId(null as unknown as string)).toBe('');
  });
});

describe('parseAssemblyIncomingPlanJson', () => {
  it('null/мусор → []', () => {
    expect(parseAssemblyIncomingPlanJson(null)).toEqual([]);
    expect(parseAssemblyIncomingPlanJson(undefined)).toEqual([]);
    expect(parseAssemblyIncomingPlanJson(42)).toEqual([]);
    expect(parseAssemblyIncomingPlanJson({})).toEqual([]);
  });

  it('массив объектов: нормализует dayOffset/qty (clamp≥0, floor) и читает nomenclatureId|partId', () => {
    const out = parseAssemblyIncomingPlanJson([
      { dayOffset: 2.7, nomenclatureId: 'n1', qty: 3.9 },
      { dayOffset: -5, partId: 'n2', qty: 1 },
    ]);
    expect(out).toEqual([
      { dayOffset: 2, nomenclatureId: 'n1', qty: 3 },
      { dayOffset: 0, nomenclatureId: 'n2', qty: 1 },
    ]);
  });

  it('пропускает строки без id или с qty<=0', () => {
    const out = parseAssemblyIncomingPlanJson([
      { dayOffset: 0, nomenclatureId: '', qty: 5 },
      { dayOffset: 0, nomenclatureId: 'n', qty: 0 },
      { dayOffset: 0, nomenclatureId: 'ok', qty: 2 },
    ]);
    expect(out).toEqual([{ dayOffset: 0, nomenclatureId: 'ok', qty: 2 }]);
  });

  it('строка с валидным JSON парсится рекурсивно; битая строка → []', () => {
    expect(parseAssemblyIncomingPlanJson('[{"nomenclatureId":"n1","qty":2,"dayOffset":1}]')).toEqual([
      { dayOffset: 1, nomenclatureId: 'n1', qty: 2 },
    ]);
    expect(parseAssemblyIncomingPlanJson('not json')).toEqual([]);
    expect(parseAssemblyIncomingPlanJson('')).toEqual([]);
  });
});
