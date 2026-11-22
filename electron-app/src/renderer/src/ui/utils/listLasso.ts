/**
 * Выделение контуром — Ctrl + рамка (промт КАРМАНА #67).
 *
 * Механики в проекте не было: выделение было только кликом по чекбоксу и Shift+кликом.
 * Чистая часть здесь — геометрия рамки и отбор строк; мышиная обвязка — в `useListLasso`.
 */

export type Point = { x: number; y: number };

export type LassoRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** Прямоугольник рамки из двух точек (мышь может идти вверх/влево). */
export function normalizeLassoRect(start: Point, end: Point): LassoRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

/** Пересекаются ли два прямоугольника (строки попадают в рамку целиком или частично). */
export function rectsIntersect(a: LassoRect, b: LassoRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/**
 * Ключи строк, попавших в рамку. Порядок — как в списке (порядок рамки не задан).
 */
export function collectLassoKeys(
  rect: LassoRect,
  rows: Array<{ key: string; left: number; top: number; right: number; bottom: number }>,
): string[] {
  return rows
    .filter((row) => rectsIntersect(rect, { left: row.left, top: row.top, right: row.right, bottom: row.bottom }))
    .map((row) => row.key);
}

/**
 * Рамка рисуется поверх интерфейса: оператор должен видеть, что именно он обводит.
 */
export function lassoRectStyle(rect: LassoRect): {
  position: 'fixed';
  left: number;
  top: number;
  width: number;
  height: number;
  border: string;
  background: string;
  pointerEvents: 'none';
  zIndex: number;
} {
  return {
    position: 'fixed',
    left: rect.left,
    top: rect.top,
    width: Math.max(0, rect.right - rect.left),
    height: Math.max(0, rect.bottom - rect.top),
    border: '1px dashed var(--danger)',
    background: 'rgba(220, 38, 38, 0.08)',
    pointerEvents: 'none',
    zIndex: 100000,
  };
}
