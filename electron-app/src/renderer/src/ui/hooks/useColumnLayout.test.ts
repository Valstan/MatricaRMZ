import { describe, expect, it } from 'vitest';

import { layoutFromPersisted } from './useColumnLayout.js';

// Смоук 16.09.2026: колонки дат, добавленные в код скрытыми по умолчанию, у оператора с уже
// сохранённой раскладкой выехали на экран — сохранённая запись их не знала, а `defaultHidden`
// применялся только к раскладке с нуля.
describe('layoutFromPersisted — новые колонки и сохранённая раскладка', () => {
  const all = ['number', 'brand', 'arrival', 'repaired', 'scrap'];

  it('без записи — порядок кода, скрытые по умолчанию', () => {
    expect(layoutFromPersisted(null, all, ['repaired', 'scrap'])).toEqual({ order: all, hidden: ['repaired', 'scrap'], widths: {} });
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
    expect(out).toEqual({ order: ['number', 'brand'], hidden: ['brand'], widths: {} });
  });

  it('ручные ширины переживают нормализацию, чужие и мусор — нет', () => {
    const persisted = {
      order: ['number', 'brand'],
      hidden: [],
      widths: { number: 200, gone: 300, junk: 'x', tiny: 5 } as unknown as Record<string, number>,
    };
    const out = layoutFromPersisted(persisted, ['number', 'brand'], []);
    expect(out.widths).toEqual({ number: 200 });
  });
});
