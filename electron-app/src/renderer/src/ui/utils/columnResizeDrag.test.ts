import { describe, expect, it } from 'vitest';

import { createResizeDrag } from './columnResizeDrag.js';

describe('columnResizeDrag: машина тяги ширины колонки (A1)', () => {
  it('движение без start ничего не даёт', () => {
    const drag = createResizeDrag();
    expect(drag.move(100)).toBeNull();
    expect(drag.finish()).toBe(false);
  });

  it('микродвижения до порога 3px ширину не меняют', () => {
    const drag = createResizeDrag();
    expect(drag.start(100, 200)).toBe(true);
    expect(drag.move(102)).toBeNull();
    expect(drag.move(97)).toBeNull();
    expect(drag.finish()).toBe(false);
  });

  it('тяга за порогом даёт ширину startW + dx и помечает движение', () => {
    const drag = createResizeDrag();
    drag.start(100, 200);
    expect(drag.move(150)).toBe(250);
    expect(drag.move(120)).toBe(220);
    expect(drag.finish()).toBe(true);
  });

  it('повтор того же значения не шумит (null)', () => {
    const drag = createResizeDrag();
    drag.start(100, 200);
    expect(drag.move(150)).toBe(250);
    expect(drag.move(150)).toBeNull();
    expect(drag.finish()).toBe(true);
  });

  it('после finish машина пуста: move молчит, повторный finish — false', () => {
    const drag = createResizeDrag();
    drag.start(100, 200);
    drag.move(150);
    expect(drag.finish()).toBe(true);
    expect(drag.active).toBe(false);
    expect(drag.move(160)).toBeNull();
    expect(drag.finish()).toBe(false);
  });

  it('abort гасит тягу без коммита', () => {
    const drag = createResizeDrag();
    drag.start(100, 200);
    drag.move(150);
    drag.abort();
    expect(drag.active).toBe(false);
    expect(drag.move(160)).toBeNull();
    expect(drag.finish()).toBe(false);
  });

  it('повторный start посреди тяги не сбрасывает её', () => {
    const drag = createResizeDrag();
    expect(drag.start(100, 200)).toBe(true);
    expect(drag.start(0, 0)).toBe(false);
    expect(drag.move(150)).toBe(250);
  });
});
