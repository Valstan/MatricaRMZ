import { describe, expect, it } from 'vitest';

import {
  CHILD_AGE_BANDS,
  applyChildFacets,
  childAgeBandOf,
  childFacetOptions,
  sanitizeChildFacetSelection,
  setChildFacetDateBound,
  toggleChildFacetValue,
  type ChildFacetRow,
  type ChildFacetSelection,
} from './childListFacets.js';

function row(over: Partial<ChildFacetRow> & { id: string }): ChildFacetRow {
  return {
    parentId: 'e1',
    parentFullName: 'Иванов Иван Иванович',
    parentDepartmentName: 'Цех №1',
    parentStatus: 'working',
    parentTerminationDate: null,
    ageYears: 9,
    birthDate: new Date(2016, 5, 20).getTime(),
    gender: 'male',
    tags: [],
    giftsThisYear: 0,
    activityState: 'active',
    ...over,
  };
}

const ROWS: ChildFacetRow[] = [
  row({ id: 'c1' }),
  row({ id: 'c2', ageYears: 5, birthDate: new Date(2020, 2, 2).getTime(), gender: 'female' }),
  row({
    id: 'c3',
    ageYears: 12,
    birthDate: new Date(2013, 10, 3).getTime(),
    tags: ['svo'],
    giftsThisYear: 2,
    activityState: 'silver',
    parentStatus: 'fired',
    parentFullName: 'Петров Пётр Петрович',
    parentDepartmentName: 'Бухгалтерия',
  }),
];

describe('фасеты детей — отбор', () => {
  it('пустой выбор не отсекает ничего', () => {
    expect(applyChildFacets(ROWS, {})).toHaveLength(3);
  });

  it('отбор по возрастному диапазону', () => {
    const selection: ChildFacetSelection = { age: ['7-10'] };
    expect(applyChildFacets(ROWS, selection).map((r) => r.id)).toEqual(['c1']);
  });

  it('отбор по признакам отбора', () => {
    const selection: ChildFacetSelection = { tags: ['svo'] };
    expect(applyChildFacets(ROWS, selection).map((r) => r.id)).toEqual(['c3']);
  });

  it('отбор по «получил/не получил подарок в этом году»', () => {
    expect(applyChildFacets(ROWS, { gifts: ['no'] }).map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(applyChildFacets(ROWS, { gifts: ['yes'] }).map((r) => r.id)).toEqual(['c3']);
  });

  it('серенькие отбираются отдельной ступенью', () => {
    expect(applyChildFacets(ROWS, { activity: ['silver'] }).map((r) => r.id)).toEqual(['c3']);
    expect(applyChildFacets(ROWS, { activity: ['active'] }).map((r) => r.id)).toEqual(['c1', 'c2']);
  });

  it('отбор по подразделению родителя', () => {
    expect(applyChildFacets(ROWS, { department: ['бухгалтерия'] }).map((r) => r.id)).toEqual(['c3']);
  });

  it('диапазон дат отсекает по дате рождения', () => {
    let selection = setChildFacetDateBound({}, 'birthDate', 'from', '2013-01-01');
    selection = setChildFacetDateBound(selection, 'birthDate', 'to', '2016-12-31');
    const ids = applyChildFacets(ROWS, selection).map((r) => r.id);
    expect(ids).toEqual(['c1', 'c3']);
  });

  it('ступени работают вместе: выбор по одному полю сужает другой', () => {
    const selection: ChildFacetSelection = { age: ['7-10'], gifts: ['no'] };
    expect(applyChildFacets(ROWS, selection).map((r) => r.id)).toEqual(['c1']);
  });
});

describe('фасеты детей — варианты ступени', () => {
  it('варианты считаются по строкам, прошедшим ОСТАЛЬНЫЕ ступени', () => {
    const selection: ChildFacetSelection = { activity: ['active'] };
    const options = childFacetOptions(ROWS, selection, 'gender');
    expect(options.find((o) => o.value === 'male')?.count).toBe(1);
    expect(options.find((o) => o.value === 'female')?.count).toBe(1);
  });

  it('своя ступень из подсчёта исключена', () => {
    const selection = toggleChildFacetValue({}, 'gifts', 'no');
    const options = childFacetOptions(ROWS, selection, 'gifts');
    expect(options.find((o) => o.value === 'no')?.count).toBe(2);
    expect(options.find((o) => o.value === 'yes')?.count).toBe(1);
  });

  it('возрастной диапазон известен заранее и показывается весь', () => {
    const options = childFacetOptions(ROWS, {}, 'age');
    expect(options).toHaveLength(CHILD_AGE_BANDS.length);
    expect(options.find((o) => o.value === '7-10')?.count).toBe(1);
  });
});

describe('фасеты детей — границы', () => {
  it('возраст попадает в диапазон по годам', () => {
    expect(childAgeBandOf(3)).toBe('0-3');
    expect(childAgeBandOf(10)).toBe('7-10');
    expect(childAgeBandOf(30)).toBe('18+');
    expect(childAgeBandOf(null)).toBeNull();
  });

  it('санитайзер отбрасывает мусор из роуминга', () => {
    const selection = sanitizeChildFacetSelection({ age: ['7-10', 42], unknown: ['x'], gifts: [] });
    expect(selection.age).toEqual(['7-10', '42']);
    expect(selection.gifts).toBeUndefined();
    expect(selection['unknown']).toBeUndefined();
  });
});
