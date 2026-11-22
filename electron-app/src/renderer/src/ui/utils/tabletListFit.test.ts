import { describe, expect, it } from 'vitest';

import { FIT_MAX_CH, FIT_MIN_CH, naturalWidthCh, planTabletFit, type FitColumn } from './tabletListFit.js';

/**
 * Планшетная укладка списков (промт КАРМАНА #70, п.2). Проверяем чистую часть:
 * что помещается в экран, что сворачивается и что остаётся читаемым.
 */
function col(index: number, kind: FitColumn['kind'], contentCh: number): FitColumn {
  return { index, kind, contentCh };
}

describe('план укладки списка под ширину экрана', () => {
  it('ширина неизвестна — ничего не прячем и не режем', () => {
    const plan = planTabletFit([col(1, 'name', 40), col(2, 'date', 12)], 0);
    expect(plan.collapsed).toEqual([]);
    expect(plan.visible).toEqual([1, 2]);
    expect(plan.widthsCh[1]).toBe(FIT_MAX_CH.name);
  });

  it('всё влезает — ширины естественные, ничего не свёрнуто', () => {
    const plan = planTabletFit([col(1, 'name', 20), col(2, 'date', 10)], 60);
    expect(plan.collapsed).toEqual([]);
    expect(plan.visible).toEqual([1, 2]);
    expect(plan.widthsCh[1]).toBe(20);
    expect(plan.widthsCh[2]).toBe(10);
  });

  it('широкую колонку ужимаем, но не в ниточку — минимум держим', () => {
    // 40ch имени + 20ch текста = 60ch при экране 40ch: имя ужимается до минимума,
    // текст отдаёт своё. Ни одна колонка не должна стать полоской.
    const plan = planTabletFit([col(1, 'name', 40), col(2, 'text', 20)], 40);
    expect(plan.collapsed).toEqual([]);
    expect(plan.widthsCh[1]).toBeGreaterThanOrEqual(FIT_MIN_CH.name);
    expect(plan.widthsCh[2]).toBeGreaterThanOrEqual(FIT_MIN_CH.text);
    const total = Object.values(plan.widthsCh).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(40);
  });

  it('не влезает даже по минимуму — лишние колонки сворачиваются, а не обрезаются', () => {
    // Минимумы десяти текстовых колонок (8ch) = 80ch при экране 40ch: ужать нечем —
    // лишние колонки сворачиваются, а не сжимаются в ниточку.
    const many: FitColumn[] = [];
    for (let i = 1; i <= 10; i += 1) many.push(col(i, i === 1 ? 'name' : 'text', 30));
    const plan = planTabletFit(many, 40);
    expect(plan.collapsed.length).toBeGreaterThan(0);
    expect(plan.visible[0]).toBe(1);
    expect(plan.visible).not.toContain(10);
    const total = Object.values(plan.widthsCh).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(40);
  });

  it('имя объекта и служебная «№» сворачиваются последними', () => {
    const plan = planTabletFit(
      [col(1, 'rownum', 3), col(2, 'name', 30), col(3, 'text', 40), col(4, 'text', 40)],
      20,
    );
    expect(plan.visible).toContain(1);
    expect(plan.visible).toContain(2);
    expect(plan.collapsed).toEqual([3, 4]);
  });

  it('колонка сверху потолка по виду данных не вылезает', () => {
    expect(naturalWidthCh(col(1, 'name', 90))).toBe(FIT_MAX_CH.name);
    expect(naturalWidthCh(col(1, 'num', 90))).toBe(FIT_MAX_CH.num);
    expect(naturalWidthCh(col(1, 'flag', 90))).toBe(FIT_MAX_CH.flag);
  });

  it('короткая колонка не растягивается и не схлопывается ниже минимума', () => {
    expect(naturalWidthCh(col(1, 'num', 3))).toBe(FIT_MIN_CH.num);
    expect(naturalWidthCh(col(1, 'date', 9))).toBe(9);
  });

  it('план не зависит от порядка колонок на входе', () => {
    const a = planTabletFit([col(1, 'name', 20), col(2, 'text', 20), col(3, 'date', 20)], 45);
    const b = planTabletFit([col(3, 'date', 20), col(1, 'name', 20), col(2, 'text', 20)], 45);
    expect(b).toEqual(a);
  });

  it('пустой список — пустой план', () => {
    const plan = planTabletFit([], 50);
    expect(plan.visible).toEqual([]);
    expect(plan.collapsed).toEqual([]);
    expect(plan.widthsCh).toEqual({});
  });
});
