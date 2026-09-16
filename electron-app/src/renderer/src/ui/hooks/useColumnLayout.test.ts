import { describe, expect, it } from 'vitest';

import { layoutFromPersisted } from './useColumnLayout.js';

// Смоук 16.09.2026: колонки дат, добавленные в код скрытыми по умолчанию, у оператора с уже
// сохранённой раскладкой выехали на экран — сохранённая запись их не знала, а `defaultHidden`
// применялся только к раскладке с нуля.
describe('layoutFromPersisted — новые колонки и сохранённая раскладка', () => {
  const all = ['number', 'brand', 'arrival', 'repaired', 'scrap'];

  it('без записи — порядок кода, скрытые по умолчанию', () => {
    expect(layoutFromPersisted(null, all, ['repaired', 'scrap'])).toEqual({ order: all, hidden: ['repaired', 'scrap'] });
  });

  it('колонка, которой нет в записи, берёт видимость из defaultHidden', () => {
    const persisted = { order: ['brand', 'number', 'arrival'], hidden: ['arrival'] };
    const out = layoutFromPersisted(persisted, all, ['repaired', 'scrap']);
    expect(out.order).toEqual(['brand', 'number', 'arrival', 'repaired', 'scrap']);
    expect(new Set(out.hidden)).toEqual(new Set(['arrival', 'repaired', 'scrap']));
  });

  it('колонка, которую оператор уже видел и оставил видимой, скрытой не становится', () => {
    const persisted = { order: ['number', 'repaired', 'brand'], hidden: [] };
    expect(layoutFromPersisted(persisted, all, ['repaired']).hidden).toEqual([]);
  });

  it('пропавшие из кода колонки вычищаются из записи', () => {
    const persisted = { order: ['number', 'gone', 'brand'], hidden: ['gone', 'brand'] };
    const out = layoutFromPersisted(persisted, ['number', 'brand'], []);
    expect(out).toEqual({ order: ['number', 'brand'], hidden: ['brand'] });
  });
});
