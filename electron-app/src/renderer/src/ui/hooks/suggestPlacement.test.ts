import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeSuggestPlacement, samePlacement, type SuggestPlacement } from './suggestPlacement.js';

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const HOOK = src('./useSuggestionDropdown.ts');

describe('suggestPlacement: размещение выпадашки детерминировано (A2)', () => {
  it('низ: попап под полем, значения целые', () => {
    const p = computeSuggestPlacement(1600, 900, { left: 100, top: 200, bottom: 232, width: 300 }, 250);
    expect(p.placement).toBe('below');
    expect(p).toEqual({ left: 100, width: 300, maxHeight: 654, placement: 'below', top: 238 });
  });

  it('верх: мало места снизу — якорим сверху', () => {
    const p = computeSuggestPlacement(1600, 900, { left: 100, top: 800, bottom: 832, width: 300 }, 250);
    expect(p.placement).toBe('above');
    expect(p).toEqual({ left: 100, width: 300, maxHeight: 786, placement: 'above', bottom: 106 });
  });

  it('край: левый зажим в padding, ширина не шире вьюпорта', () => {
    const p = computeSuggestPlacement(800, 600, { left: 700, top: 100, bottom: 132, width: 300 }, 500);
    expect(p.width).toBeLessThanOrEqual(800 - 16);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(800 - 8);
  });

  it('идемпотентность: повторный расчёт по тем же входам равен — цикл сходится', () => {
    const args = [1600, 900, { left: 100.4, top: 200.7, bottom: 232.2, width: 300.9 }, 250.3] as const;
    const first = computeSuggestPlacement(...args);
    const second = computeSuggestPlacement(...args);
    expect(second).toEqual(first);
    expect(samePlacement(first, second)).toBe(true);
  });

  it('samePlacement различает смену стороны и сдвиг', () => {
    const below: SuggestPlacement = { left: 100, width: 300, maxHeight: 600, placement: 'below', top: 238 };
    const belowShifted: SuggestPlacement = { ...below, top: 239 };
    const above: SuggestPlacement = { left: 100, width: 300, maxHeight: 600, placement: 'above', bottom: 100 };
    expect(samePlacement(below, { ...below })).toBe(true);
    expect(samePlacement(below, belowShifted)).toBe(false);
    expect(samePlacement(below, above)).toBe(false);
    expect(samePlacement(below, null)).toBe(false);
    expect(samePlacement(null, null)).toBe(false);
  });
});

describe('useSuggestionDropdown: setState только при смене размещения (A2)', () => {
  it('хук считает чистой функцией и сравнивает с прошлым через ref', () => {
    expect(HOOK).toContain('computeSuggestPlacement');
    expect(HOOK).toContain('samePlacement');
    // Последнее применённое размещение живёт в ref, а не в стейте.
    expect(HOOK).toMatch(/placedRef|lastPlacementRef/);
  });

  it('безусловного setPopupRect в эффекте позиционирования больше нет', () => {
    // Единственный setPopupRect — за сравнением (иначе инлайн-options гонят вечный цикл).
    const hits = HOOK.match(/setPopupRect\(/g) ?? [];
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});
