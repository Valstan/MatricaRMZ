import { describe, expect, it } from 'vitest';

import { applyScrapCriterionToMetadata, mergeScrapCriterionIntoMetadata } from './partScrapCriterionMeta.js';

// Метка «деталь уводит двигатель в утиль» в карточке детали на сервере:
// блоб — копия для показа, источник правды — EAV-атрибут. Старый хвост из
// блоба не должен воскресить снятую метку при следующей записи карточки.

describe('метка утиля в блобе карточки детали', () => {
  it('метка подмешивается в блоб вместе со своим описанием', () => {
    const merged = mergeScrapCriterionIntoMetadata({ description: 'Блок цилиндров' }, true);
    expect(merged?.custom?.scrap_criterion).toBe(true);
    expect(merged?.customDefs?.some((d) => d.code === 'scrap_criterion')).toBe(true);
    expect(merged?.description).toBe('Блок цилиндров');
  });

  it('без метки блоб не трогаем', () => {
    const merged = mergeScrapCriterionIntoMetadata({ description: 'Картер' }, null);
    expect(merged).toEqual({ description: 'Картер' });
  });

  it('снятая метка не воскресает из блоба', () => {
    const stale = { custom: { scrap_criterion: true }, customDefs: [{ code: 'scrap_criterion', name: 'x', dataType: 'boolean' }] };
    const next = applyScrapCriterionToMetadata(stale, false);
    expect(next?.custom?.scrap_criterion, 'EAV — источник правды: в блобе должно лежать false').toBe(false);
  });

  it('метка, которой нет в EAV, из блоба вычищается', () => {
    const stale = { custom: { scrap_criterion: true } };
    const next = applyScrapCriterionToMetadata(stale, null);
    expect(next?.custom?.scrap_criterion).toBeUndefined();
  });

  it('чужие пользовательские поля не теряются', () => {
    const next = applyScrapCriterionToMetadata({ custom: { другой: 'значение' } }, null);
    expect(next?.custom?.другой).toBe('значение');
  });
});
