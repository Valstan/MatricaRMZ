import { describe, expect, it } from 'vitest';

import { FACET_CHIP_GROUP_GAP, layoutFacetChipGroups, type FacetChipGroup } from './facetChipLayout.js';

function overlaps(a: { left: number; width: number }, b: { left: number; width: number }): boolean {
  return a.left + a.width > b.left + 0.5 && b.left + b.width > a.left + 0.5;
}

function planOf(groups: readonly FacetChipGroup[], available = 1200) {
  const plan = layoutFacetChipGroups(groups, available);
  return {
    plan,
    boxes: groups.map((group) => ({
      id: group.id,
      left: plan.positions[group.id] ?? 0,
      width: group.width,
    })),
  };
}

describe('раскладка плавающих плашек фильтра', () => {
  it('пустой ряд — пустая раскладка', () => {
    const plan = layoutFacetChipGroups([], 1200);
    expect(plan.positions).toEqual({});
    expect(plan.totalWidth).toBe(0);
  });

  it('группа без соседей стоит точно под своей кнопкой', () => {
    const { plan, boxes } = planOf([{ id: 'a', width: 120, parentCenter: 300 }]);
    expect(boxes[0]!.left).toBe(240);
    expect(plan.totalWidth).toBe(120);
  });

  it('места хватает — каждая группа остаётся под своим родителем', () => {
    const { boxes } = planOf([
      { id: 'a', width: 120, parentCenter: 300 },
      { id: 'b', width: 90, parentCenter: 700 },
      { id: 'c', width: 60, parentCenter: 1000 },
    ]);
    expect(boxes[0]!.left).toBe(240);
    expect(boxes[1]!.left).toBe(655);
    expect(boxes[2]!.left).toBe(970);
  });

  it('наехавшие друг на друга группы разводятся: правая сдвигается вправо', () => {
    const { boxes } = planOf([
      { id: 'a', width: 200, parentCenter: 300 },
      { id: 'b', width: 200, parentCenter: 380 },
    ]);
    expect(overlaps(boxes[0]!, boxes[1]!), 'плашки разных ступеней не наезжают друг на друга').toBe(false);
    // Левая осталась под родителем, правая сдвинулась ровно настолько, чтобы разойтись.
    expect(boxes[0]!.left).toBe(200);
    expect(boxes[1]!.left).toBe(200 + 200 + FACET_CHIP_GROUP_GAP);
  });

  it('порядок групп не нарушается: правая группа не уезжает левее левой', () => {
    const { boxes } = planOf([
      { id: 'a', width: 300, parentCenter: 200 },
      { id: 'b', width: 300, parentCenter: 260 },
      { id: 'c', width: 300, parentCenter: 320 },
    ]);
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.left, `группа ${i} левее предыдущей`).toBeGreaterThan(boxes[i - 1]!.left);
      expect(overlaps(boxes[i - 1]!, boxes[i]!)).toBe(false);
    }
  });

  it('ряды не выходят за правый край, когда плашки в сумме влезают', () => {
    const { plan, boxes } = planOf(
      [
        { id: 'a', width: 200, parentCenter: 950 },
        { id: 'b', width: 200, parentCenter: 990 },
      ],
      1000,
    );
    for (const box of boxes) {
      expect(box.left, `группа ${box.id} уехала за правый край`).toBeLessThanOrEqual(1000 - box.width + 0.5);
      expect(box.left).toBeGreaterThanOrEqual(-0.5);
    }
    expect(plan.canvasWidth).toBe(1000);
  });

  it('когда плашки шире ряда — полотно расширяется, наезда всё равно нет', () => {
    const { plan, boxes } = planOf(
      [
        { id: 'a', width: 400, parentCenter: 100 },
        { id: 'b', width: 400, parentCenter: 200 },
      ],
      300,
    );
    expect(plan.canvasWidth).toBe(400 * 2 + FACET_CHIP_GROUP_GAP);
    expect(overlaps(boxes[0]!, boxes[1]!)).toBe(false);
  });

  it('группа шире полотна не уезжает влево за его край', () => {
    const { boxes } = planOf([{ id: 'a', width: 900, parentCenter: 50 }], 400);
    expect(boxes[0]!.left).toBe(0);
  });
});
