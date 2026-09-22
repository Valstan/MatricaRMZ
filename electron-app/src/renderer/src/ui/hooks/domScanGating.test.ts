import { describe, expect, it } from 'vitest';

import {
  autoGrowContentLength,
  autoGrowWidthCss,
  computeAutoGrowChars,
  shouldDeferScan,
  shouldRecalcListTables,
  shouldSyncAutoGrowInputs,
  shouldWriteValue,
  type ScanMutationLike,
} from './domScanGating.js';

// Жалоба владельца 22.09.2026: «мышка медленнее ходит». Два наблюдателя у корня приложения
// слушали весь документ, поэтому набор буквы в чате заказывал обход строк всех таблиц.
// Здесь проверяется ровно решение «стоит ли обходить» — без DOM, окружение тестов node.

type FakeNode = {
  matches?: (selector: string) => boolean;
  querySelector?: (selector: string) => unknown;
  closest?: (selector: string) => unknown;
  parentElement?: FakeNode | null;
};

function element(spec: { self?: string[]; inside?: string[]; ancestors?: string[] } = {}): FakeNode {
  const self = new Set(spec.self ?? []);
  const inside = new Set(spec.inside ?? []);
  const ancestors = new Set(spec.ancestors ?? []);
  return {
    matches: (selector) => self.has(selector),
    querySelector: (selector) => (inside.has(selector) ? {} : null),
    closest: (selector) => (self.has(selector) || ancestors.has(selector) ? {} : null),
    parentElement: null,
  };
}

/** characterData приходит на текстовый узел: closest у него нет, только parentElement. */
function textNode(parent: FakeNode): FakeNode {
  return { parentElement: parent };
}

const TABLE = 'table.list-table';

describe('shouldRecalcListTables — что заказывает пересчёт таблиц', () => {
  it('набор текста в чате пересчёта не заказывает', () => {
    const chatLine = element({ ancestors: ['.chat-pane'] });
    const mutations: ScanMutationLike[] = [{ type: 'characterData', target: textNode(chatLine) }];
    expect(shouldRecalcListTables(mutations)).toBe(false);
  });

  it('правка поля ввода вне таблицы пересчёта не заказывает', () => {
    const field = element({ self: ['input'] });
    expect(shouldRecalcListTables([{ type: 'childList', target: field, addedNodes: [] }])).toBe(false);
  });

  it('изменение текста в ячейке таблицы списка — заказывает', () => {
    const cell = element({ ancestors: [TABLE] });
    expect(shouldRecalcListTables([{ type: 'characterData', target: textNode(cell) }])).toBe(true);
  });

  it('впервые отрисованная таблица приходит добавленным узлом снаружи — и тоже заказывает', () => {
    const container = element();
    const added = element({ inside: [TABLE] });
    expect(shouldRecalcListTables([{ type: 'childList', target: container, addedNodes: [added] }])).toBe(true);
  });

  it('смена активной вкладки — единственный атрибут, по которому пересчитываем', () => {
    const pane = element();
    expect(
      shouldRecalcListTables([{ type: 'attributes', attributeName: 'data-pane-active', target: pane }]),
    ).toBe(true);
    expect(shouldRecalcListTables([{ type: 'attributes', attributeName: 'class', target: pane }])).toBe(false);
  });

  it('в пачке достаточно одной подходящей мутации', () => {
    const chatLine = element({ ancestors: ['.chat-pane'] });
    const cell = element({ ancestors: [TABLE] });
    expect(
      shouldRecalcListTables([
        { type: 'characterData', target: textNode(chatLine) },
        { type: 'characterData', target: textNode(cell) },
      ]),
    ).toBe(true);
  });
});

describe('shouldDeferScan — пересчёт во время прокрутки', () => {
  it('сразу после события прокрутки — откладываем', () => {
    expect(shouldDeferScan(1_000, 1_050, 200)).toBe(true);
  });

  it('после паузы — считаем', () => {
    expect(shouldDeferScan(1_000, 1_400, 200)).toBe(false);
  });

  it('если не прокручивали вовсе — не откладываем', () => {
    expect(shouldDeferScan(0, 5_000, 200)).toBe(false);
  });
});

describe('shouldWriteValue — не переписываем одинаковое', () => {
  it('то же значение в DOM не пишется', () => {
    expect(shouldWriteValue('18', '18')).toBe(false);
    expect(shouldWriteValue('24ch', '24ch')).toBe(false);
  });

  it('изменившееся и впервые появившееся — пишется', () => {
    expect(shouldWriteValue('17', '18')).toBe(true);
    expect(shouldWriteValue('', '18')).toBe(true);
    expect(shouldWriteValue(null, '18')).toBe(true);
  });

  it('пустое снятие поверх пустого — не пишется', () => {
    expect(shouldWriteValue(null, '')).toBe(false);
    expect(shouldWriteValue('', '')).toBe(false);
  });
});

describe('shouldSyncAutoGrowInputs — что заказывает проход автоширины', () => {
  const size = { minChars: 10, maxChars: 48, extraChars: 2 };

  it('строки виртуального списка без полей ввода прохода не заказывают', () => {
    const row = element({ self: ['tr'] });
    expect(shouldSyncAutoGrowInputs([{ type: 'childList', target: element(), addedNodes: [row] }])).toBe(false);
  });

  it('добавленная форма с полем внутри — заказывает', () => {
    const form = element({ inside: ['input'] });
    expect(shouldSyncAutoGrowInputs([{ type: 'childList', target: element(), addedNodes: [form] }])).toBe(true);
  });

  it('атрибуты (type/placeholder/pane) — заказывают всегда', () => {
    expect(
      shouldSyncAutoGrowInputs([{ type: 'attributes', attributeName: 'placeholder', target: element() }]),
    ).toBe(true);
  });

  it('ширина растёт по значению, а без значения — по подсказке', () => {
    expect(autoGrowContentLength('Иванов', 'Фамилия')).toBe(6);
    expect(autoGrowContentLength('', 'Фамилия')).toBe(7);
    expect(autoGrowContentLength('', '')).toBe(1);
  });

  it('ширина зажата между min и max и считается в ch', () => {
    expect(computeAutoGrowChars(3, size)).toBe(10);
    expect(computeAutoGrowChars(20, size)).toBe(22);
    expect(computeAutoGrowChars(200, size)).toBe(48);
    expect(autoGrowWidthCss(computeAutoGrowChars(20, size))).toBe('22ch');
  });
});
