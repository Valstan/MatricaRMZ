import { describe, expect, it } from 'vitest';

import {
  buildBomSnapshot,
  computeMissingComponentTypes,
  type EngineBomDetailsForSnapshot,
  type EngineBomLine,
} from './engineBomCardLogic.js';

function makeLine(partial: Partial<EngineBomLine> = {}): EngineBomLine {
  return {
    id: 'line-1',
    componentNomenclatureId: 'nom-1',
    componentType: 'sleeve',
    qtyPerUnit: 1,
    variantGroup: null,
    lineKey: null,
    parentLineKey: null,
    isRequired: true,
    priority: 100,
    notes: null,
    ...partial,
  };
}

function makeData(partialLines: Array<Partial<EngineBomLine>> = []): EngineBomDetailsForSnapshot {
  return {
    header: { id: 'bom-1', name: 'BOM', engineBrandIds: ['brand-1'], status: 'active', isDefault: true, notes: null },
    lines: partialLines.map((line, idx) => makeLine({ id: `line-${idx + 1}`, ...line })),
  };
}

describe('buildBomSnapshot', () => {
  it('возвращает пустую строку для null', () => {
    expect(buildBomSnapshot(null)).toBe('');
  });

  it('учитывает priority при сравнении — backend перестал переписывать в v1.21.5', () => {
    const a = buildBomSnapshot(makeData([{ priority: 100 }]));
    const b = buildBomSnapshot(makeData([{ priority: 5 }]));
    expect(a).not.toBe(b);
  });

  it('меняется когда меняется componentType', () => {
    const a = buildBomSnapshot(makeData([{ componentType: 'sleeve' }]));
    const b = buildBomSnapshot(makeData([{ componentType: 'carter' }]));
    expect(a).not.toBe(b);
  });

  it('меняется когда меняется componentNomenclatureId', () => {
    const a = buildBomSnapshot(makeData([{ componentNomenclatureId: 'nom-1' }]));
    const b = buildBomSnapshot(makeData([{ componentNomenclatureId: 'nom-2' }]));
    expect(a).not.toBe(b);
  });

  it('engineBrandIds сортируются, чтобы порядок не влиял на snapshot', () => {
    const dataA: EngineBomDetailsForSnapshot = { ...makeData(), header: { ...makeData().header, engineBrandIds: ['b', 'a'] } };
    const dataB: EngineBomDetailsForSnapshot = { ...makeData(), header: { ...makeData().header, engineBrandIds: ['a', 'b'] } };
    expect(buildBomSnapshot(dataA)).toBe(buildBomSnapshot(dataB));
  });
});

describe('computeMissingComponentTypes', () => {
  it('пустой data возвращает []', () => {
    expect(computeMissingComponentTypes(null, ['sleeve'])).toEqual([]);
  });

  it('пустые requiredTypes возвращают []', () => {
    expect(computeMissingComponentTypes(makeData([{ componentType: 'sleeve' }]), [])).toEqual([]);
  });

  it('для пустой BOM возвращает все типы как missing в base scope', () => {
    const result = computeMissingComponentTypes(makeData([]), ['sleeve', 'piston', 'carter']);
    expect(result).toHaveLength(1);
    expect(result[0]?.scope).toBe('__base__');
    expect(result[0]?.missingTypeIds).toEqual(['sleeve', 'piston', 'carter']);
  });

  it('base-only: возвращает только отсутствующие типы', () => {
    const result = computeMissingComponentTypes(
      makeData([{ componentType: 'sleeve' }, { componentType: 'piston' }]),
      ['sleeve', 'piston', 'carter'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.missingTypeIds).toEqual(['carter']);
  });

  it('base-only без missing типов возвращает []', () => {
    const result = computeMissingComponentTypes(
      makeData([{ componentType: 'sleeve' }, { componentType: 'piston' }]),
      ['sleeve', 'piston'],
    );
    expect(result).toEqual([]);
  });

  it('с kit-вариантами: проверяет полноту каждого __kit_*, игнорируя base', () => {
    const result = computeMissingComponentTypes(
      makeData([
        { componentType: 'sleeve', variantGroup: '__kit_abc' },
        { componentType: 'piston', variantGroup: '__kit_abc' },
        { componentType: 'sleeve', variantGroup: '__kit_def' },
      ]),
      ['sleeve', 'piston', 'carter'],
    );
    const byScope = new Map(result.map((entry) => [entry.scope, entry.missingTypeIds]));
    expect(byScope.get('__kit_abc')).toEqual(['carter']);
    expect(byScope.get('__kit_def')).toEqual(['piston', 'carter']);
    expect(byScope.has('__base__')).toBe(false);
  });

  it('игнорирует случай регистра в componentType', () => {
    const result = computeMissingComponentTypes(
      makeData([{ componentType: 'SLEEVE' }]),
      ['sleeve', 'piston'],
    );
    expect(result[0]?.missingTypeIds).toEqual(['piston']);
  });
});
