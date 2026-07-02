import { describe, expect, it } from 'vitest';

import { buildAssemblyForecastKits } from '../services/warehouseForecastService.js';

// Pure-функция тестируется без mocks — без БД, без drizzle, без сети.
// Edge cases v1.22.0 (план bom-refactor-2026-05.md §v1.22.0):
//   1. Пустой BOM
//   2. Soft-deleted nomenclature в строке
//   3. Variant kit с broken parentLineKey
//   4. Несколько kit-вариантов (без warning, design feature)
//   5. Несколько active+isDefault BOM для одной марки

type HeaderRow = {
  id: string;
  name: string | null;
  updatedAt: number | null;
  engineBrandId: string;
};
type LineRow = {
  bomId: string;
  componentNomenclatureId: string;
  componentType: string;
  qtyPerUnit: number;
  variantGroup: string | null;
  notes: string | null;
};
type NomMeta = { id: string; code: string | null; name: string | null; deletedAt: number | null };

function header(over: Partial<HeaderRow> & { id: string; engineBrandId: string }): HeaderRow {
  return { name: 'BOM', updatedAt: 1, ...over };
}

function line(over: Partial<LineRow> & { bomId: string; componentNomenclatureId: string }): LineRow {
  return {
    componentType: 'piston',
    qtyPerUnit: 1,
    variantGroup: null,
    notes: null,
    ...over,
  };
}

function nom(over: Partial<NomMeta> & { id: string }): NomMeta {
  return { code: 'CODE', name: 'Поршень', deletedAt: null, ...over };
}

function asNomMap(rows: NomMeta[]): Map<string, NomMeta> {
  return new Map(rows.map((r) => [r.id, r]));
}

const brandLabels = new Map([
  ['brand-a', 'А-41'],
  ['brand-b', 'СМД-60'],
]);

describe('buildAssemblyForecastKits — edge case #1: BOM без строк', () => {
  it('пропускает марку и генерирует warning', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [header({ id: 'bom-empty', engineBrandId: 'brand-a' })],
      lineRows: [],
      nomenclatureById: asNomMap([]),
      brandLabels,
    });
    expect(result.kits).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('А-41');
    expect(result.warnings[0]).toContain('не содержит строк');
  });
});

describe('buildAssemblyForecastKits — edge case #2: soft-deleted nomenclature', () => {
  it('исключает строку и генерирует warning с количеством', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [header({ id: 'bom-1', engineBrandId: 'brand-a' })],
      lineRows: [
        line({ bomId: 'bom-1', componentNomenclatureId: 'nom-alive', componentType: 'piston' }),
        line({ bomId: 'bom-1', componentNomenclatureId: 'nom-deleted', componentType: 'sleeve' }),
        line({ bomId: 'bom-1', componentNomenclatureId: 'nom-deleted-2', componentType: 'ring' }),
      ],
      nomenclatureById: asNomMap([
        nom({ id: 'nom-alive' }),
        nom({ id: 'nom-deleted', deletedAt: 12345 }),
        nom({ id: 'nom-deleted-2', deletedAt: 12345 }),
      ]),
      brandLabels,
    });
    expect(result.kits).toHaveLength(1);
    expect(result.kits[0]!.parts.map((p) => p.nomenclatureId)).toEqual(['nom-alive']);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    const deletedWarning = result.warnings.find((w) => w.includes('удалённую номенклатуру'));
    expect(deletedWarning).toBeDefined();
    expect(deletedWarning).toContain('2');
    expect(deletedWarning).toContain('А-41');
  });

  it('все строки указывают на удалённую номенклатуру → kit не создаётся, warning о пустом валидном BOM', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [header({ id: 'bom-all-dead', engineBrandId: 'brand-a' })],
      lineRows: [line({ bomId: 'bom-all-dead', componentNomenclatureId: 'nom-dead' })],
      nomenclatureById: asNomMap([nom({ id: 'nom-dead', deletedAt: 1 })]),
      brandLabels,
    });
    expect(result.kits).toEqual([]);
    expect(result.warnings.some((w) => w.includes('удалённую'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('не содержит валидных строк'))).toBe(true);
  });
});

describe('buildAssemblyForecastKits — edge case #3: broken parentLineKey', () => {
  it('исключает строку с parentLineKey ссылающимся на несуществующий lineKey + warning', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [header({ id: 'bom-broken', engineBrandId: 'brand-a' })],
      lineRows: [
        // baseline: только дочерняя строка, без родителя — её parentLineKey не находит цели
        line({
          bomId: 'bom-broken',
          componentNomenclatureId: 'nom-child',
          componentType: 'ring',
          variantGroup: '__kit_x',
          notes: JSON.stringify({
            format: 'bom_line_meta_v1',
            lineKey: 'child-key',
            parentLineKey: 'missing-parent',
          }),
        }),
        // нормальная базовая строка для гарантии что kit вообще что-то содержит
        line({
          bomId: 'bom-broken',
          componentNomenclatureId: 'nom-base',
          componentType: 'piston',
        }),
      ],
      nomenclatureById: asNomMap([nom({ id: 'nom-base' }), nom({ id: 'nom-child' })]),
      brandLabels,
    });
    expect(result.warnings.some((w) => w.includes('broken parentLineKey'))).toBe(true);
    // строка-сирота не должна попасть в kits
    const partIds = result.kits.flatMap((k) => k.parts.map((p) => p.nomenclatureId));
    expect(partIds).toContain('nom-base');
    expect(partIds).not.toContain('nom-child');
  });
});

describe('buildAssemblyForecastKits — edge case #4: несколько kit-вариантов (без warning)', () => {
  it('каждый variantGroup даёт отдельный kit, ни одного warning не генерируется', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [header({ id: 'bom-multi-kit', engineBrandId: 'brand-a' })],
      lineRows: [
        line({ bomId: 'bom-multi-kit', componentNomenclatureId: 'nom-base', componentType: 'piston' }),
        line({
          bomId: 'bom-multi-kit',
          componentNomenclatureId: 'nom-kit1',
          componentType: 'sleeve',
          variantGroup: '__kit_1',
        }),
        line({
          bomId: 'bom-multi-kit',
          componentNomenclatureId: 'nom-kit2',
          componentType: 'sleeve',
          variantGroup: '__kit_2',
        }),
      ],
      nomenclatureById: asNomMap([
        nom({ id: 'nom-base' }),
        nom({ id: 'nom-kit1' }),
        nom({ id: 'nom-kit2' }),
      ]),
      brandLabels,
    });
    // 2 kit'а (по одному на variantGroup), оба содержат base строку
    expect(result.kits).toHaveLength(2);
    expect(result.warnings).toEqual([]);
    expect(result.kits.map((k) => k.brandLabel)).toEqual(['А-41 (вариант 1)', 'А-41 (вариант 2)']);
  });
});

describe('buildAssemblyForecastKits — edge case #5: несколько active+isDefault BOM для марки', () => {
  it('берёт самый свежий по updatedAt и генерирует warning', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [
        header({ id: 'bom-old', engineBrandId: 'brand-a', name: 'Old BOM', updatedAt: 100 }),
        header({ id: 'bom-new', engineBrandId: 'brand-a', name: 'New BOM', updatedAt: 200 }),
      ],
      lineRows: [
        line({ bomId: 'bom-old', componentNomenclatureId: 'nom-old' }),
        line({ bomId: 'bom-new', componentNomenclatureId: 'nom-new' }),
      ],
      nomenclatureById: asNomMap([nom({ id: 'nom-old' }), nom({ id: 'nom-new' })]),
      brandLabels,
    });
    // только свежий BOM используется
    expect(result.kits).toHaveLength(1);
    expect(result.kits[0]!.parts.map((p) => p.nomenclatureId)).toEqual(['nom-new']);
    // warning с упоминанием количества и имени свежей
    const collisionWarning = result.warnings.find((w) => w.includes('Несколько активных default BOM'));
    expect(collisionWarning).toBeDefined();
    expect(collisionWarning).toContain('А-41');
    expect(collisionWarning).toContain('New BOM');
    expect(collisionWarning).toContain('2');
  });

  it('один BOM на марку — никакого warning', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [
        header({ id: 'bom-a', engineBrandId: 'brand-a', updatedAt: 100 }),
        header({ id: 'bom-b', engineBrandId: 'brand-b', updatedAt: 100 }),
      ],
      lineRows: [
        line({ bomId: 'bom-a', componentNomenclatureId: 'nom-1' }),
        line({ bomId: 'bom-b', componentNomenclatureId: 'nom-2' }),
      ],
      nomenclatureById: asNomMap([nom({ id: 'nom-1' }), nom({ id: 'nom-2' })]),
      brandLabels,
    });
    expect(result.kits).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });
});

describe('buildAssemblyForecastKits — happy path', () => {
  it('нет input → пустой результат без warning', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [],
      lineRows: [],
      nomenclatureById: asNomMap([]),
      brandLabels,
    });
    expect(result.kits).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('две марки с обычными BOM → 2 kits, 0 warnings', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [
        header({ id: 'bom-a', engineBrandId: 'brand-a' }),
        header({ id: 'bom-b', engineBrandId: 'brand-b' }),
      ],
      lineRows: [
        line({ bomId: 'bom-a', componentNomenclatureId: 'nom-1', componentType: 'piston', qtyPerUnit: 4 }),
        line({ bomId: 'bom-a', componentNomenclatureId: 'nom-2', componentType: 'sleeve', qtyPerUnit: 4 }),
        line({ bomId: 'bom-b', componentNomenclatureId: 'nom-3', componentType: 'head', qtyPerUnit: 1 }),
      ],
      nomenclatureById: asNomMap([nom({ id: 'nom-1' }), nom({ id: 'nom-2' }), nom({ id: 'nom-3' })]),
      brandLabels,
    });
    expect(result.warnings).toEqual([]);
    expect(result.kits).toHaveLength(2);
    expect(result.kits.find((k) => k.brandId === 'brand-a')!.parts).toHaveLength(2);
    expect(result.kits.find((k) => k.brandId === 'brand-b')!.parts).toHaveLength(1);
  });

  it('qtyPerUnit=0 или пустой componentNomenclatureId → строка игнорируется без warning', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [header({ id: 'bom-zero', engineBrandId: 'brand-a' })],
      lineRows: [
        line({ bomId: 'bom-zero', componentNomenclatureId: 'nom-ok', qtyPerUnit: 1 }),
        line({ bomId: 'bom-zero', componentNomenclatureId: 'nom-zero', qtyPerUnit: 0 }),
        line({ bomId: 'bom-zero', componentNomenclatureId: '', qtyPerUnit: 1 }),
      ],
      nomenclatureById: asNomMap([nom({ id: 'nom-ok' }), nom({ id: 'nom-zero' })]),
      brandLabels,
    });
    expect(result.warnings).toEqual([]);
    expect(result.kits).toHaveLength(1);
    expect(result.kits[0]!.parts.map((p) => p.nomenclatureId)).toEqual(['nom-ok']);
  });
});

describe('buildAssemblyForecastKits — edge case #6: дробный qtyPerUnit', () => {
  it('0.5 → строка выпадает, 2.5 → усекается до 2; один warning на BOM', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [header({ id: 'bom-frac', engineBrandId: 'brand-a' })],
      lineRows: [
        line({ bomId: 'bom-frac', componentNomenclatureId: 'nom-half', qtyPerUnit: 0.5 }),
        line({ bomId: 'bom-frac', componentNomenclatureId: 'nom-two-half', qtyPerUnit: 2.5 }),
        line({ bomId: 'bom-frac', componentNomenclatureId: 'nom-int', qtyPerUnit: 3 }),
      ],
      nomenclatureById: asNomMap([nom({ id: 'nom-half' }), nom({ id: 'nom-two-half' }), nom({ id: 'nom-int' })]),
      brandLabels,
    });
    const fracWarning = result.warnings.find((w) => w.includes('дробным'));
    expect(fracWarning).toBeDefined();
    expect(fracWarning).toContain('А-41');
    expect(fracWarning).toContain('2 строк');
    expect(result.kits).toHaveLength(1);
    const parts = result.kits[0]!.parts;
    expect(parts.map((p) => [p.nomenclatureId, p.qtyPerEngine])).toEqual([
      ['nom-two-half', 2],
      ['nom-int', 3],
    ]);
  });

  it('целые qtyPerUnit → warning не генерируется', () => {
    const result = buildAssemblyForecastKits({
      headerRows: [header({ id: 'bom-int', engineBrandId: 'brand-a' })],
      lineRows: [line({ bomId: 'bom-int', componentNomenclatureId: 'nom-ok', qtyPerUnit: 2 })],
      nomenclatureById: asNomMap([nom({ id: 'nom-ok' })]),
      brandLabels,
    });
    expect(result.warnings).toEqual([]);
  });
});
