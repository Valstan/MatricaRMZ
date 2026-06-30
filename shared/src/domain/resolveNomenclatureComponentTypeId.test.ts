import { describe, expect, it } from 'vitest';

import { resolveNomenclatureComponentTypeId } from './warehouse.js';

describe('resolveNomenclatureComponentTypeId', () => {
  it('prefers native componentTypeId column over specJson and heuristic', () => {
    // v1.22.0 block C: новая нативная колонка `erp_nomenclature.component_type_id` имеет
    // высший приоритет — выигрывает даже если specJson содержит другое значение, а имя
    // подсказывает третий тип.
    const result = resolveNomenclatureComponentTypeId({
      componentTypeId: 'carter',
      name: 'Поршень в сборе',
      code: null,
      category: null,
      itemType: null,
      specJson: JSON.stringify({ componentTypeId: 'sleeve' }),
    });
    expect(result).toBe('carter');
  });

  it('trims and ignores empty/whitespace componentTypeId column', () => {
    // Пустая/whitespace колонка не должна затыкать fallback на specJson.
    const result = resolveNomenclatureComponentTypeId({
      componentTypeId: '   ',
      name: 'whatever',
      code: null,
      category: null,
      itemType: null,
      specJson: JSON.stringify({ componentTypeId: 'piston' }),
    });
    expect(result).toBe('piston');
  });

  it('falls back to specJson when column is null', () => {
    // Transitional period: backfill ещё не прогнан, новая колонка NULL — читаем specJson.
    const result = resolveNomenclatureComponentTypeId({
      componentTypeId: null,
      name: 'whatever',
      code: null,
      category: null,
      itemType: null,
      specJson: JSON.stringify({ componentTypeId: 'head' }),
    });
    expect(result).toBe('head');
  });

  it('prefers explicit specJson.componentTypeId over heuristic', () => {
    // У номенклатуры имя «Гильза» (эвристика бы вернула sleeve), но оператор явно
    // выбрал «carter» в карточке номенклатуры — приоритет у явного выбора.
    const result = resolveNomenclatureComponentTypeId({
      name: 'Гильза 303-07-22',
      code: null,
      category: null,
      itemType: null,
      specJson: JSON.stringify({ componentTypeId: 'carter' }),
    });
    expect(result).toBe('carter');
  });

  it('falls back to heuristic when specJson has no componentTypeId', () => {
    const result = resolveNomenclatureComponentTypeId({
      name: 'Поршень в сборе',
      code: null,
      category: null,
      itemType: null,
      specJson: JSON.stringify({ source: 'part', partId: 'x' }),
    });
    expect(result).toBe('piston');
  });

  it('falls back to heuristic when specJson is null', () => {
    const result = resolveNomenclatureComponentTypeId({
      name: 'Картер двигателя',
      code: null,
      category: null,
      itemType: null,
      specJson: null,
    });
    expect(result).toBe('carter');
  });

  it('returns "engine" for category=engine regardless of name', () => {
    const result = resolveNomenclatureComponentTypeId({
      name: 'whatever',
      code: null,
      category: 'engine',
      itemType: null,
      specJson: null,
    });
    expect(result).toBe('engine');
  });

  it('returns null when neither specJson nor heuristic can determine the type', () => {
    const result = resolveNomenclatureComponentTypeId({
      name: 'Болт М10',
      code: 'BOLT-001',
      category: null,
      itemType: null,
      specJson: null,
    });
    expect(result).toBeNull();
  });

  it('ignores malformed specJson and uses heuristic', () => {
    const result = resolveNomenclatureComponentTypeId({
      name: 'Кольцо',
      code: null,
      category: null,
      itemType: null,
      specJson: '{not json',
    });
    expect(result).toBe('ring');
  });

  it('ignores empty string componentTypeId in specJson', () => {
    const result = resolveNomenclatureComponentTypeId({
      name: 'Головка блока',
      code: null,
      category: null,
      itemType: null,
      specJson: JSON.stringify({ componentTypeId: '   ' }),
    });
    expect(result).toBe('head');
  });
});
