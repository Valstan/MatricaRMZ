import { describe, expect, it } from 'vitest';

import { GESTURE_DEAD_ZONE_PX, createEdgeGesture } from './edgeGesture.js';

/** Левая выдвижная панель: жест вправо открывает, ход 300px. */
function leftDrawer(open = false) {
  return createEdgeGesture({ axis: 'x', size: 300, direction: 1, open });
}

describe('распознавание', () => {
  it('короткий тап не начинает жест — панель остаётся как была', () => {
    const g = leftDrawer();
    g.start({ x: 10, y: 100, t: 0 });
    g.move({ x: 14, y: 102, t: 40 });
    const r = g.end({ x: 14, y: 102, t: 60 });
    expect(r.open).toBe(false);
    expect(r.progress).toBe(0);
  });

  it('вертикальное движение отменяет жест — палец продолжает прокручивать список', () => {
    const g = leftDrawer();
    g.start({ x: 10, y: 100, t: 0 });
    const s = g.move({ x: 16, y: 160, t: 50 });
    expect(s.phase).toBe('cancelled');
    expect(g.move({ x: 200, y: 160, t: 80 }).progress).toBe(0);
    expect(g.end().open).toBe(false);
  });

  it('поперечная ось меряется с запасом: почти горизонтальный свайп захватывается', () => {
    const g = leftDrawer();
    g.start({ x: 10, y: 100, t: 0 });
    expect(g.move({ x: 60, y: 110, t: 50 }).phase).toBe('captured');
  });
});

describe('следование за пальцем', () => {
  it('прогресс считается от хода за вычетом мёртвой зоны', () => {
    const g = leftDrawer();
    g.start({ x: 0, y: 100, t: 0 });
    const s = g.move({ x: 150 + GESTURE_DEAD_ZONE_PX, y: 104, t: 100 });
    expect(s.progress).toBeCloseTo(0.5, 5);
  });

  it('прогресс зажат в 0..1 при переходе за полный ход', () => {
    const g = leftDrawer();
    g.start({ x: 0, y: 0, t: 0 });
    expect(g.move({ x: 900, y: 4, t: 100 }).progress).toBe(1);
  });

  it('открытая панель тем же жестом закрывается', () => {
    const g = leftDrawer(true);
    g.start({ x: 280, y: 100, t: 0 });
    const s = g.move({ x: 280 - 150 - GESTURE_DEAD_ZONE_PX, y: 104, t: 120 });
    expect(s.progress).toBeCloseTo(0.5, 5);
  });
});

describe('решение на отпускании', () => {
  it('неполный свайп откатывается', () => {
    const g = leftDrawer();
    g.start({ x: 0, y: 0, t: 0 });
    g.move({ x: 60, y: 2, t: 100 });
    const r = g.end({ x: 62, y: 2, t: 200 });
    expect(r.open).toBe(false);
    expect(r.progress).toBe(0);
  });

  it('свайп за порог открывает', () => {
    const g = leftDrawer();
    g.start({ x: 0, y: 0, t: 0 });
    g.move({ x: 100, y: 2, t: 100 });
    const r = g.end({ x: 160, y: 2, t: 400 });
    expect(r.open).toBe(true);
    expect(r.progress).toBe(1);
  });

  it('быстрый флик открывает и на коротком ходе', () => {
    const g = leftDrawer();
    g.start({ x: 0, y: 0, t: 0 });
    g.move({ x: 20, y: 1, t: 10 });
    g.move({ x: 70, y: 2, t: 30 });
    const r = g.end({ x: 70, y: 2, t: 30 });
    expect(r.open).toBe(true);
  });

  it('обратный флик закрывает открытую панель', () => {
    const g = leftDrawer(true);
    g.start({ x: 280, y: 0, t: 0 });
    g.move({ x: 260, y: 1, t: 10 });
    g.move({ x: 210, y: 2, t: 30 });
    const r = g.end({ x: 210, y: 2, t: 30 });
    expect(r.open).toBe(false);
  });

  it('открытую панель закрывает только заметный ход (порог симметричен)', () => {
    const g = leftDrawer(true);
    g.start({ x: 280, y: 0, t: 0 });
    g.move({ x: 230, y: 2, t: 200 });
    const r = g.end({ x: 228, y: 2, t: 400 });
    expect(r.open).toBe(true);
  });

  it('перехват системой (свайп «назад») закрывает панель без полусостояний', () => {
    const g = leftDrawer();
    g.start({ x: 12, y: 100, t: 0 });
    g.move({ x: 120, y: 104, t: 80 });
    const r = g.cancel();
    expect(r.open).toBe(false);
    expect(r.progress).toBe(0);
  });
});

describe('верхний слой', () => {
  it('свайп вниз от верхнего хэндла возвращает шапку', () => {
    const g = createEdgeGesture({ axis: 'y', size: 120, direction: 1, open: false });
    g.start({ x: 500, y: 4, t: 0 });
    g.move({ x: 502, y: 90, t: 120 });
    const r = g.end({ x: 502, y: 95, t: 300 });
    expect(r.open).toBe(true);
  });
});
