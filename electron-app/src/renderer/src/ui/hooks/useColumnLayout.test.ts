import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyHideOnce, setColumnLayoutUser } from './columnLayoutStore.js';
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

// Владелец 19.10.2026 (P6): «дата внесения» ушла из показа по умолчанию, но сохранённые
// раскладки её знают — `layoutFromPersisted` их намеренно не трогает («оператор её видел»).
// Поэтому смена умолчания для жившей колонки объявлена отдельно и срабатывает один раз.
describe('applyHideOnce — разовая миграция умолчаний', () => {
  const LAYOUT = 'list:engines:columns';
  const all = ['arrival', 'stageDate', 'updatedAt'];

  const store = new Map<string, string>();
  const localStorageStub = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  };

  beforeEach(() => {
    store.clear();
    setColumnLayoutUser('operator1');
    vi.stubGlobal('window', { localStorage: localStorageStub });
  });

  afterEach(() => {
    setColumnLayoutUser('');
    vi.unstubAllGlobals();
  });

  it('прячет жившую колонку, но не переписывает уже скрытую', () => {
    expect(applyHideOnce(LAYOUT, all, { order: all, hidden: ['stageDate'] })).toEqual({
      order: all,
      hidden: ['stageDate', 'updatedAt'],
    });
    expect(applyHideOnce(LAYOUT, all, { order: all, hidden: [] })).toBeNull();
  });

  it('отметка ставится и тогда, когда колонка уже была скрыта', () => {
    // Свежая раскладка уже получает `updatedAt` из defaultHidden — миграции делать нечего,
    // но второй раз ей тоже нечего: отметка хранится отдельно от раскладки.
    expect(applyHideOnce(LAYOUT, all, { order: all, hidden: ['updatedAt'] })).toBeNull();
    expect(applyHideOnce(LAYOUT, all, { order: all, hidden: [] })).toBeNull();
  });

  it('включил колонку обратно — второй раз не прячем (человек решил явно)', () => {
    expect(applyHideOnce(LAYOUT, all, { order: all, hidden: [] })).not.toBeNull();
    // Оператор вернул «Дату изменения» в «Колонках списка»: состояние перечитается, а
    // миграция уже отработала — иначе колонка пропадала бы после каждого входа в список.
    expect(applyHideOnce(LAYOUT, all, { order: all, hidden: [] })).toBeNull();
  });

  it('неизвестную раскладку и неизвестную колонку не трогает', () => {
    expect(applyHideOnce('list:parts:columns', all, { order: all, hidden: [] })).toBeNull();
    expect(applyHideOnce(LAYOUT, ['arrival'], { order: ['arrival'], hidden: [] })).toBeNull();
  });

  it('отметка у каждого оператора своя: на общей станции прячет и второму', () => {
    expect(applyHideOnce(LAYOUT, all, { order: all, hidden: [] })).not.toBeNull();
    setColumnLayoutUser('operator2');
    expect(applyHideOnce(LAYOUT, all, { order: all, hidden: [] })).not.toBeNull();
  });
});
