import { describe, expect, it, vi } from 'vitest';

// Модуль тянет db на импорте — для чистых хелперов соединение не нужно.
vi.mock('../database/db.js', () => ({ db: {} }));

import { dedupeAssemblyBomCandidates, pickDefaultAssemblyBom } from './assemblyPlanningService.js';

function candidate(bomId: string, isDefaultForBrand = false) {
  return { bomId, bomName: `BOM ${bomId}`, version: 1, defaultVariantKey: null, isDefaultForBrand };
}

describe('pickDefaultAssemblyBom', () => {
  it('единственная активная BOM марки выбирается и без флага «основная»', () => {
    // Регрессия: флаг `defaultForBrandIds` редактор BOM не отправляет ни разу, поэтому
    // требование флага делало любой выбор двигателя в сборочном наряде тупиком.
    expect(pickDefaultAssemblyBom([candidate('a')])?.bomId).toBe('a');
  });

  it('флаг «основная» решает при нескольких BOM', () => {
    expect(pickDefaultAssemblyBom([candidate('a'), candidate('b', true)])?.bomId).toBe('b');
  });

  it('два кандидата без флага — неоднозначность, выбирает оператор', () => {
    expect(pickDefaultAssemblyBom([candidate('a'), candidate('b')])).toBeNull();
  });

  it('два флага «основная» — тоже неоднозначность', () => {
    expect(pickDefaultAssemblyBom([candidate('a', true), candidate('b', true)])).toBeNull();
  });

  it('пустой список — нечего выбирать', () => {
    expect(pickDefaultAssemblyBom([])).toBeNull();
  });
});

describe('dedupeAssemblyBomCandidates', () => {
  it('дубль связки (bom, марка) не превращает одну BOM в конфликт двух', () => {
    const deduped = dedupeAssemblyBomCandidates([candidate('a'), candidate('a')]);
    expect(deduped).toHaveLength(1);
    expect(pickDefaultAssemblyBom(deduped)?.bomId).toBe('a');
  });

  it('флаг «основная» склеивается по OR', () => {
    const deduped = dedupeAssemblyBomCandidates([candidate('a'), candidate('a', true), candidate('b')]);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((row) => row.bomId === 'a')?.isDefaultForBrand).toBe(true);
    expect(pickDefaultAssemblyBom(deduped)?.bomId).toBe('a');
  });

  it('разные BOM сохраняются', () => {
    expect(dedupeAssemblyBomCandidates([candidate('a'), candidate('b')])).toHaveLength(2);
  });
});
