import { describe, expect, it } from 'vitest';

import { listDragRowStyle, listDropIndicatorStyle, resolveDropTarget } from './listDragVisual.js';

const rects = [
  { key: 'a', top: 0, bottom: 20 },
  { key: 'b', top: 20, bottom: 40 },
  { key: 'c', top: 40, bottom: 60 },
];

describe('место вставки при перетаскивании', () => {
  it('над строкой — вставка перед ней', () => {
    expect(resolveDropTarget(5, rects)).toEqual({ index: 0, key: 'a', position: 'before' });
  });

  it('ниже середины строки — вставка после неё', () => {
    expect(resolveDropTarget(35, rects)).toEqual({ index: 2, key: 'b', position: 'after' });
  });

  it('выше первой строки — в начало списка', () => {
    expect(resolveDropTarget(-10, rects)).toEqual({ index: 0, key: 'a', position: 'before' });
  });

  it('ниже последней строки — в конец списка', () => {
    expect(resolveDropTarget(200, rects)).toEqual({ index: 3, key: 'c', position: 'after' });
  });

  it('пустой список — места вставки нет', () => {
    expect(resolveDropTarget(10, [])).toBeNull();
  });

  it('строки, приехавшие не по порядку, считаются по вертикали', () => {
    const shuffled = [rects[2]!, rects[0]!, rects[1]!];
    expect(resolveDropTarget(5, shuffled)).toEqual({ index: 0, key: 'a', position: 'before' });
  });
});

describe('подсветка перетаскиваемой строки', () => {
  it('перетаскиваемая строка обведена — оператор видит, что именно тащит', () => {
    expect(listDragRowStyle('a', 'a')).toEqual({
      opacity: 0.55,
      outline: '2px solid var(--danger)',
      outlineOffset: '-2px',
    });
  });

  it('остальные строки не трогаются', () => {
    expect(listDragRowStyle('a', 'b')).toEqual({});
  });

  it('когда перетаскивания нет — стили обычные', () => {
    expect(listDragRowStyle(null, 'a')).toEqual({});
  });
});

describe('линия места вставки', () => {
  it('строка-цель показывает, что вставка будет ПЕРЕД ней', () => {
    expect(listDropIndicatorStyle({ key: 'b', position: 'before' }, 'b')).toEqual({
      boxShadow: 'inset 0 2px 0 0 var(--danger)',
    });
  });

  it('строка-цель показывает, что вставка будет ПОСЛЕ неё', () => {
    expect(listDropIndicatorStyle({ key: 'b', position: 'after' }, 'b')).toEqual({
      boxShadow: 'inset 0 -2px 0 0 var(--danger)',
    });
  });

  it('остальные строки не трогаются', () => {
    expect(listDropIndicatorStyle({ key: 'b', position: 'before' }, 'c')).toEqual({});
  });

  it('когда перетаскивания нет — линии нет', () => {
    expect(listDropIndicatorStyle(null, 'b')).toEqual({});
  });
});
