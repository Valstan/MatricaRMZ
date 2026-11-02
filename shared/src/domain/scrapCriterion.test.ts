import { describe, expect, it } from 'vitest';

import {
  EMPTY_SCRAP_CRITERION_SET,
  createScrapCriterionSet,
  findScrapCriterionHit,
  isLegacyCrankcaseName,
  isScrapCriterionEngineUtil,
  matchesScrapCriterion,
  normalizeScrapPartName,
} from './scrapCriterion.js';

describe('признак «деталь уводит двигатель в утиль»', () => {
  const set = createScrapCriterionSet(['PART-CYL', 'NOM-CYL'], ['Блок цилиндров']);

  it('нормализует имя: краи и пробелы не мешают сопоставлению', () => {
    expect(normalizeScrapPartName('  Блок   Цилиндров ')).toBe('блок цилиндров');
    expect(normalizeScrapPartName(null)).toBe('');
  });

  it('узнаёт деталь по id', () => {
    expect(matchesScrapCriterion({ partId: 'PART-CYL' }, set)).toBe(true);
    expect(matchesScrapCriterion({ partId: 'NOM-CYL' }, set)).toBe(true);
    expect(matchesScrapCriterion({ partId: 'PART-OTHER' }, set)).toBe(false);
  });

  it('узнаёт деталь по имени, когда id в строке акта не записан', () => {
    expect(matchesScrapCriterion({ partName: 'Блок цилиндров' }, set)).toBe(true);
    expect(matchesScrapCriterion({ partName: '  блок  цилиндров ' }, set)).toBe(true);
    expect(matchesScrapCriterion({ partName: 'Блок цилиндров БМЗ' }, set)).toBe(false);
  });

  it('чужая деталь в утиле двигатель не уводит', () => {
    expect(matchesScrapCriterion({ partId: 'PART-OTHER', partName: 'Форсунка' }, set)).toBe(false);
    expect(findScrapCriterionHit([{ partId: 'PART-OTHER', partName: 'Форсунка' }], set)).toBe(null);
  });

  it('старое правило «картер» живёт, пока картер не переведён в галку', () => {
    expect(isLegacyCrankcaseName('Картер верхний')).toBe(true);
    expect(matchesScrapCriterion({ partName: 'Картер верхний' }, EMPTY_SCRAP_CRITERION_SET)).toBe(true);
    // Выключается одним флагом — после переноса картера в галку.
    expect(
      matchesScrapCriterion({ partName: 'Картер верхний' }, EMPTY_SCRAP_CRITERION_SET, { legacyCrankcase: false }),
    ).toBe(false);
  });

  it('находит, какая именно деталь уводит двигатель в утиль', () => {
    const hit = findScrapCriterionHit(
      [
        { partId: 'PART-OTHER', partName: 'Форсунка' },
        { partId: 'PART-CYL', partName: 'Блок цилиндров' },
      ],
      set,
    );
    expect(hit?.partId).toBe('PART-CYL');
  });

  it('пустой набор не уводит ни одну деталь (кроме картера по старому правилу)', () => {
    expect(findScrapCriterionHit([{ partName: 'Форсунка' }], EMPTY_SCRAP_CRITERION_SET)).toBe(null);
  });
});

describe('признак утиля двигателя по деталям', () => {
  const set = createScrapCriterionSet(['PART-CYL'], ['Блок цилиндров']);
  const parts = [{ partId: 'PART-CYL', partName: 'Блок цилиндров' }];

  it('деталь-критерий в утиле — двигатель утильный', () => {
    expect(isScrapCriterionEngineUtil(parts, set)).toBe(true);
  });

  it('чужой утиль утильным двигатель не делает', () => {
    expect(isScrapCriterionEngineUtil([{ partName: 'Форсунка' }], set)).toBe(false);
  });

  it('снятие утиля позже источника гасит признак', () => {
    expect(isScrapCriterionEngineUtil(parts, set, { scrapResolvedAt: 2000, sourceAt: 1000 })).toBe(false);
  });

  it('снятие раньше источника утиль оставляет', () => {
    expect(isScrapCriterionEngineUtil(parts, set, { scrapResolvedAt: 500, sourceAt: 1000 })).toBe(true);
  });

  it('снятие при неизвестном моменте источника гасит признак', () => {
    expect(isScrapCriterionEngineUtil(parts, set, { scrapResolvedAt: 2000, sourceAt: null })).toBe(false);
  });
});
