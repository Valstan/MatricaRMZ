import { describe, expect, it } from 'vitest';

import {
  addBrandGroupToBom,
  BOM_BASE_SCOPE,
  buildBomSnapshot,
  computeMissingComponentTypes,
  filterBomLineIdxs,
  genBomKitKey,
  groupBomLinesForCard,
  listBomScopes,
  pruneDefaultForBrands,
  toggleDefaultForBrand,
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

  it('меняется когда переключили «основная для марки»', () => {
    // Без этого поля в снапшоте галочка не помечает карточку грязной и правка теряется
    // при закрытии — тот же класс молчаливой потери, что GOTCHAS M53.
    const base = makeData();
    const a = buildBomSnapshot(base);
    const b = buildBomSnapshot({ ...base, header: { ...base.header, defaultForBrandIds: ['brand-1'] } });
    expect(a).not.toBe(b);
  });

  it('порядок марок в defaultForBrandIds не создаёт ложной грязи', () => {
    const base = makeData();
    const a = buildBomSnapshot({ ...base, header: { ...base.header, engineBrandIds: ['brand-1', 'brand-2'], defaultForBrandIds: ['brand-1', 'brand-2'] } });
    const b = buildBomSnapshot({ ...base, header: { ...base.header, engineBrandIds: ['brand-2', 'brand-1'], defaultForBrandIds: ['brand-2', 'brand-1'] } });
    expect(a).toBe(b);
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

describe('toggleDefaultForBrand', () => {
  it('включает флаг для марки', () => {
    expect(toggleDefaultForBrand([], 'brand-1', true)).toEqual(['brand-1']);
  });

  it('снимает флаг', () => {
    expect(toggleDefaultForBrand(['brand-1', 'brand-2'], 'brand-1', false)).toEqual(['brand-2']);
  });

  it('повторное включение не копит дубли', () => {
    expect(toggleDefaultForBrand(['brand-1'], 'brand-1', true)).toEqual(['brand-1']);
  });

  it('терпит null/undefined', () => {
    expect(toggleDefaultForBrand(null, 'brand-1', true)).toEqual(['brand-1']);
    expect(toggleDefaultForBrand(undefined, 'brand-1', false)).toEqual([]);
  });
});

describe('pruneDefaultForBrands', () => {
  it('выкидывает основные марки, которых больше нет в списке марок', () => {
    // Иначе сервер отвергает весь upsert: «defaultForBrandIds должен быть подмножеством».
    expect(pruneDefaultForBrands(['brand-1', 'brand-2'], ['brand-2'])).toEqual(['brand-2']);
  });

  it('пустой список марок обнуляет основные', () => {
    expect(pruneDefaultForBrands(['brand-1'], [])).toEqual([]);
  });

  it('подмножество не трогает', () => {
    expect(pruneDefaultForBrands(['brand-1'], ['brand-1', 'brand-2'])).toEqual(['brand-1']);
  });
});

describe('buildBomSnapshot — норма расхода', () => {
  it('меняется когда правят normPercent (E1: поле редактируется в карточке)', () => {
    const a = buildBomSnapshot(makeData([{ normPercent: 40 }]));
    const b = buildBomSnapshot(makeData([{ normPercent: 60 }]));
    expect(a).not.toBe(b);
  });
});

describe('listBomScopes / genBomKitKey', () => {
  it('база всегда первая, киты отсортированы', () => {
    const lines = [makeLine({ variantGroup: '__kit_b' }), makeLine(), makeLine({ variantGroup: '__kit_a' })];
    expect(listBomScopes(lines)).toEqual([BOM_BASE_SCOPE, '__kit_a', '__kit_b']);
  });
  it('без китов — только база', () => {
    expect(listBomScopes([makeLine()])).toEqual([BOM_BASE_SCOPE]);
  });
  it('ключ кита имеет служебный префикс', () => {
    expect(genBomKitKey(() => 0.123456789)).toMatch(/^__kit_[a-z0-9]{6,8}$/);
  });
});

describe('groupBomLinesForCard', () => {
  const order = new Map([
    ['sleeve', 20],
    ['piston', 30],
    ['other', 900],
  ]);

  it('раскладывает по типу в порядке схемы, строки чужого комплекта не берёт', () => {
    const lines = [
      makeLine({ componentType: 'other', componentNomenclatureId: 'o1' }),
      makeLine({ componentType: 'sleeve', componentNomenclatureId: 's1' }),
      makeLine({ componentType: 'sleeve', componentNomenclatureId: 'kit', variantGroup: '__kit_x' }),
    ];
    const sections = groupBomLinesForCard(lines, BOM_BASE_SCOPE, order);
    expect(sections.map((s) => s.typeId)).toEqual(['sleeve', 'other']);
    expect(sections[0]!.positions).toEqual([{ posKey: 'solo-1', primaryIdx: 1, backupIdxs: [] }]);
    expect(groupBomLinesForCard(lines, '__kit_x', order)[0]!.positions[0]!.primaryIdx).toBe(2);
  });

  it('варианты одной позиции: основная — primary, остальные — запасные, даже если основная не первая', () => {
    const lines = [
      makeLine({ positionKey: 'p1', isDefaultOption: false, componentNomenclatureId: 'b1' }),
      makeLine({ positionKey: 'p1', isDefaultOption: true, componentNomenclatureId: 'main' }),
      makeLine({ positionKey: 'p1', isDefaultOption: false, componentNomenclatureId: 'b2' }),
    ];
    const [section] = groupBomLinesForCard(lines, BOM_BASE_SCOPE, order);
    expect(section!.positions).toEqual([{ posKey: 'p1', primaryIdx: 1, backupIdxs: [0, 2] }]);
  });

  it('тип раздела — у основной строки; незнакомый тип уходит в конец', () => {
    const lines = [
      makeLine({ componentType: 'zzz', componentNomenclatureId: 'z' }),
      makeLine({ componentType: 'piston', componentNomenclatureId: 'p' }),
    ];
    expect(groupBomLinesForCard(lines, BOM_BASE_SCOPE, order).map((s) => s.typeId)).toEqual(['piston', 'zzz']);
  });

  it('внутри раздела — по priority, затем по подписи', () => {
    const lines = [
      makeLine({ componentType: 'other', priority: 200, componentNomenclatureId: 'b' }),
      makeLine({ componentType: 'other', priority: 100, componentNomenclatureId: 'z' }),
      makeLine({ componentType: 'other', priority: 100, componentNomenclatureId: 'a' }),
    ];
    const [section] = groupBomLinesForCard(lines, BOM_BASE_SCOPE, order);
    expect(section!.positions.map((p) => p.primaryIdx)).toEqual([2, 1, 0]);
  });
});

describe('filterBomLineIdxs', () => {
  it('пустой запрос — null (фильтра нет)', () => {
    expect(filterBomLineIdxs([makeLine()], '  ', (l) => l.componentNomenclatureId)).toBeNull();
  });
  it('ищет без учёта регистра по тексту строки', () => {
    const lines = [makeLine({ componentNomenclatureName: 'Гильза 303' }), makeLine({ componentNomenclatureName: 'Поршень' })];
    expect(filterBomLineIdxs(lines, 'гиль', (l) => l.componentNomenclatureName ?? '')).toEqual(new Set([0]));
  });
});

describe('addBrandGroupToBom', () => {
  it('добавляет марки группы без дублей, сохраняя порядок выбранных', () => {
    expect(addBrandGroupToBom(['b2', 'b1'], ['b1', 'b3', 'b3', ' '])).toEqual({ engineBrandIds: ['b2', 'b1', 'b3'], added: 1 });
  });
  it('группа целиком уже привязана — ничего не добавляет', () => {
    expect(addBrandGroupToBom(['b1'], ['b1']).added).toBe(0);
  });
});
