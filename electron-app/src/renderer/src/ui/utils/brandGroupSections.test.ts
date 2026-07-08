import { describe, expect, it } from 'vitest';

import { groupBrandsIntoSections } from './brandGroupSections.js';

type Brand = { id: string; name: string };

const brands: Brand[] = [
  { id: 'a', name: 'А-41' },
  { id: 'b', name: 'СМД-60' },
  { id: 'c', name: 'ЯМЗ-238' },
  { id: 'd', name: 'Д-240' },
];
const groups = [
  { id: 'g1', label: 'Гусеничные' },
  { id: 'g2', label: 'Колёсные' },
];

describe('groupBrandsIntoSections', () => {
  it('раскладывает марки по секциям групп + «Без группы» в конце', () => {
    const brandToGroups = new Map<string, string[]>([
      ['a', ['g1']],
      ['b', ['g2']],
      // c, d — без группы
    ]);
    const sections = groupBrandsIntoSections(brands, brandToGroups, groups, 'Без группы');
    expect(sections.map((s) => [s.groupId, s.brands.map((b) => b.id)])).toEqual([
      ['g1', ['a']],
      ['g2', ['b']],
      [null, ['c', 'd']],
    ]);
  });

  it('марка в нескольких группах показывается в каждой своей секции (дубль осознан)', () => {
    const brandToGroups = new Map<string, string[]>([
      ['a', ['g1', 'g2']],
      ['b', ['g2']],
    ]);
    const sections = groupBrandsIntoSections(brands, brandToGroups, groups, 'Без группы');
    expect(sections.find((s) => s.groupId === 'g1')!.brands.map((b) => b.id)).toEqual(['a']);
    expect(sections.find((s) => s.groupId === 'g2')!.brands.map((b) => b.id)).toEqual(['a', 'b']);
    // c, d без группы
    expect(sections.find((s) => s.groupId === null)!.brands.map((b) => b.id)).toEqual(['c', 'd']);
  });

  it('пустые секции опускаются; порядок групп сохраняется как во входе', () => {
    const brandToGroups = new Map<string, string[]>([['a', ['g2']]]);
    const sections = groupBrandsIntoSections(brands, brandToGroups, groups, 'Без группы');
    // g1 пустая → опущена; g2 первой, затем «Без группы»
    expect(sections.map((s) => s.groupId)).toEqual(['g2', null]);
  });

  it('порядок марок внутри секции сохраняется как во входном массиве', () => {
    const reordered: Brand[] = [brands[2]!, brands[0]!, brands[1]!]; // c, a, b
    const brandToGroups = new Map<string, string[]>([
      ['a', ['g1']],
      ['b', ['g1']],
      ['c', ['g1']],
    ]);
    const sections = groupBrandsIntoSections(reordered, brandToGroups, groups, 'Без группы');
    expect(sections[0]!.brands.map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('нет групп → всё в «Без группы»', () => {
    const sections = groupBrandsIntoSections(brands, new Map(), [], 'Без группы');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.groupId).toBeNull();
    expect(sections[0]!.brands).toHaveLength(4);
  });

  it('пустой список марок → нет секций', () => {
    const sections = groupBrandsIntoSections([], new Map(), groups, 'Без группы');
    expect(sections).toEqual([]);
  });
});
