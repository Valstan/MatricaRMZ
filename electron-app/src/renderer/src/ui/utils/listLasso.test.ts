import { describe, expect, it } from 'vitest';

import { collectLassoKeys, normalizeLassoRect, rectsIntersect } from './listLasso.js';

describe('рамка выделения контуром', () => {
  it('рамка нормализуется, даже если мышь шла вверх-влево', () => {
    expect(normalizeLassoRect({ x: 100, y: 80 }, { x: 20, y: 10 })).toEqual({
      left: 20,
      top: 10,
      right: 100,
      bottom: 80,
    });
  });

  it('строка попадает в рамку, если рамка её задела', () => {
    const rect = normalizeLassoRect({ x: 0, y: 0 }, { x: 50, y: 50 });
    expect(rectsIntersect(rect, { left: 40, top: 40, right: 80, bottom: 60 })).toBe(true);
    expect(rectsIntersect(rect, { left: 60, top: 60, right: 80, bottom: 80 })).toBe(false);
  });

  it('в рамку попадают только пересечённые строки, порядок — как в списке', () => {
    const rect = normalizeLassoRect({ x: 0, y: 0 }, { x: 50, y: 50 });
    const rows = [
      { key: 'a', left: 0, top: 0, right: 100, bottom: 20 },
      { key: 'b', left: 0, top: 20, right: 100, bottom: 40 },
      { key: 'c', left: 0, top: 40, right: 100, bottom: 60 },
      { key: 'd', left: 0, top: 60, right: 100, bottom: 80 },
    ];
    expect(collectLassoKeys(rect, rows)).toEqual(['a', 'b', 'c']);
  });

  it('пустая рамка не выделяет ничего', () => {
    const rect = normalizeLassoRect({ x: 500, y: 500 }, { x: 600, y: 600 });
    expect(collectLassoKeys(rect, [{ key: 'a', left: 0, top: 0, right: 10, bottom: 10 }])).toEqual([]);
  });
});
