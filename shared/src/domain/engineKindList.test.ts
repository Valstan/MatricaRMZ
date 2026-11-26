import { describe, expect, it } from 'vitest';

import {
  CONTRACT_KIND_SHORT_LABELS,
  ENGINE_KIND_FACET_OPTIONS,
  ENGINE_KIND_NONE_LABEL,
  compareEngineKind,
  engineKindById,
  engineKindFacetDescriptor,
  engineKindGroupKey,
  engineKindRank,
  engineKindShortLabel,
} from './engineKindList.js';
import { flattenGrouped } from './listGrouping.js';
import { facetOptions } from './listFacets.js';
import type { ContractKind } from './contract.js';

// Промт КАРМАНА #163: вид — полноценный признак (фильтр, сортировка, группировка),
// подписи короткие в кнопках и ступенях, порядок задан, а не по алфавиту, и считается
// вид по одному правилу (это — `engineKind.ts`; здесь слой над ним).
describe('подписи вида', () => {
  it('короткая подпись — одна на всю программу', () => {
    expect(CONTRACT_KIND_SHORT_LABELS.military).toBe('ГОЗ');
    expect(CONTRACT_KIND_SHORT_LABELS.civil).toBe('Гражд.');
    expect(engineKindShortLabel('military')).toBe('ГОЗ');
    expect(engineKindShortLabel('civil')).toBe('Гражд.');
    expect(engineKindShortLabel(null)).toBe(ENGINE_KIND_NONE_LABEL);
    expect(engineKindShortLabel(null)).toBe('Вид не задан');
  });

  it('короткая подпись отличается от полной в карточке', () => {
    // Полная подпись («Гражданский») живёт в карточках и печати — она длиннее и там есть
    // место. Короткая — только в тесных местах.
    expect(CONTRACT_KIND_SHORT_LABELS.civil).not.toBe('Гражданский');
  });
});

describe('порядок вида', () => {
  it('задан: ГОЗ → гражданский → вид не задан', () => {
    expect(engineKindRank('military')).toBeLessThan(engineKindRank('civil'));
    expect(engineKindRank('civil')).toBeLessThan(engineKindRank(null));
    expect(compareEngineKind('military', 'civil')).toBeLessThan(0);
    expect(compareEngineKind(null, 'military')).toBeGreaterThan(0);
    expect(compareEngineKind('civil', 'civil')).toBe(0);
  });

  it('«вид не задан» встал бы в начало по алфавиту — поэтому порядок задан явно', () => {
    // Подписи по алфавиту: «Вид не задан» раньше «ГОЗ». Сортировка по подписи убрала бы
    // «вид не задан» наверх, и отбор «ГОЗ» выглядел бы пустым.
    const labels = ['Вид не задан', 'ГОЗ', 'Гражд.'].sort((a, b) => a.localeCompare(b, 'ru'));
    expect(labels[0]).toBe('Вид не задан');
    expect(engineKindRank(null)).toBeGreaterThan(engineKindRank('military'));
  });

  it('группы идут в том же порядке, что и сортировка', () => {
    const rows = [
      { id: 'a', kind: null as ContractKind | null },
      { id: 'b', kind: 'civil' as ContractKind | null },
      { id: 'c', kind: 'military' as ContractKind | null },
    ];
    const items = flattenGrouped(rows, [{ keyOf: (r) => engineKindGroupKey(r.kind) }]);
    const groups = items.filter((it) => it.kind === 'group').map((it) => (it.kind === 'group' ? it.label : ''));
    expect(groups).toEqual(['ГОЗ', 'Гражд.', 'Вид не задан']);
  });

  it('в каждой группе видно число строк', () => {
    const rows = [
      { id: 'a', kind: 'military' as ContractKind | null },
      { id: 'b', kind: 'military' as ContractKind | null },
      { id: 'c', kind: 'civil' as ContractKind | null },
    ];
    const items = flattenGrouped(rows, [{ keyOf: (r) => engineKindGroupKey(r.kind) }]);
    const counts = items.filter((it) => it.kind === 'group').map((it) => (it.kind === 'group' ? it.count : 0));
    expect(counts).toEqual([2, 1]);
  });
});

describe('ступень «Вид» — общий конструктор', () => {
  type Row = { kind?: ContractKind | null };
  const rows: Row[] = [
    { kind: 'military' },
    { kind: 'civil' },
    { kind: null },
  ];

  it('значение и подпись строки — по общему правилу', () => {
    const facet = engineKindFacetDescriptor<Row>({ kindOf: (r) => r.kind });
    expect(facet.id).toBe('kind');
    expect(facet.label).toBe('Вид');
    if (facet.kind !== 'values') throw new Error('ступень должна быть перечислением');
    expect(facet.valueOf(rows[0]!)).toEqual({ value: 'military', label: 'ГОЗ' });
    expect(facet.valueOf(rows[1]!)).toEqual({ value: 'civil', label: 'Гражд.' });
    expect(facet.valueOf(rows[2]!)).toEqual({ value: 'none', label: 'Вид не задан' });
  });

  it('ряд значений полный: вида, которого нет ни в одной строке, ступень не теряет', () => {
    const facet = engineKindFacetDescriptor<Row>({ kindOf: (r) => r.kind });
    if (facet.kind !== 'values') throw new Error('ступень должна быть перечислением');
    expect(facet.options?.map((o) => o.value)).toEqual(['military', 'civil', 'none']);
    expect(ENGINE_KIND_FACET_OPTIONS.map((o) => o.label)).toEqual(['ГОЗ', 'Гражд.', 'Вид не задан']);
  });

  it('у договора значения «вид не задан» нет — вида у него не бывает', () => {
    const facet = engineKindFacetDescriptor<Row>({ kindOf: (r) => r.kind, includeNone: false });
    if (facet.kind !== 'values') throw new Error('ступень должна быть перечислением');
    expect(facet.options?.map((o) => o.value)).toEqual(['military', 'civil']);
  });

  it('ступень отбирает ровно свой вид, а «вид не задан» — отдельным значением', () => {
    const facet = engineKindFacetDescriptor<Row>({ kindOf: (r) => r.kind });
    const options = facetOptions([facet], rows, {}, 'kind');
    expect(options.map((o) => o.value)).toEqual(['military', 'civil', 'none']);
    expect(options.map((o) => o.count)).toEqual([1, 1, 1]);
  });
});

describe('вид по каталогу двигателей', () => {
  it('вид берётся из строки двигателя, второй раз не считается', () => {
    const map = engineKindById([
      { id: 'e1', kind: 'military' },
      { id: 'e2', kind: null },
      { id: '', kind: 'civil' },
    ]);
    expect(map.get('e1')).toBe('military');
    expect(map.get('e2')).toBeNull();
    expect(map.size).toBe(2);
  });

  it('двигателя без вида в карте нет — вид остаётся «не задан»', () => {
    const map = engineKindById([{ id: 'e1', kind: 'civil' }]);
    expect(map.get('missing') ?? null).toBeNull();
  });
});
