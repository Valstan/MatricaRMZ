/**
 * Визуальное сопровождение перетаскивания строк — общий слой (промт КАРМАНА #67).
 *
 * До сих пор состояние перетаскивания жило прямо в странице производственной программы:
 * подсветки перетаскиваемой строки не было, линии места вставки не было, а `onDragEnd`
 * не стояло вовсе — состояние не сбрасывалось, если оператор отменил перетаскивание
 * (Esc или drop мимо строки). Здесь — чистая часть (считает место вставки и что видно
 * оператору), React-обвязка живёт в `useListDrag`.
 */

export type ListDragSource = {
  /** Ключ перетаскиваемого объекта (строка или группа). */
  key: string;
  kind?: 'row' | 'group';
};

export type ListRowRect = {
  key: string;
  top: number;
  bottom: number;
};

export type ListDropTarget = {
  /** Индекс вставки в упорядоченном массиве строк. */
  index: number;
  /** Ключ строки, рядом с которой вставляем (для рисовки линии). */
  key: string | null;
  /** Линия рисуется ПЕРЕД строкой (`before`) или ПОСЛЕ неё (`after`). */
  position: 'before' | 'after';
};

/**
 * Место вставки по позиции курсора: над строкой — перед ней, под строкой — после.
 * Верхняя и нижняя половины строки делят её пополам — иначе «куда встанет» читается
 * случайно, а это ровно то, что заказчик назвал неудобным.
 */
export function resolveDropTarget(clientY: number, rects: ListRowRect[]): ListDropTarget | null {
  if (!rects.length) return null;
  const sorted = [...rects].sort((a, b) => a.top - b.top);
  for (let i = 0; i < sorted.length; i += 1) {
    const rect = sorted[i]!;
    if (clientY < rect.top) {
      return { index: i, key: rect.key, position: 'before' };
    }
    if (clientY <= rect.bottom) {
      const middle = (rect.top + rect.bottom) / 2;
      return clientY < middle
        ? { index: i, key: rect.key, position: 'before' }
        : { index: i + 1, key: rect.key, position: 'after' };
    }
  }
  const last = sorted[sorted.length - 1]!;
  return { index: sorted.length, key: last.key, position: 'after' };
}

/**
 * Что оператор должен видеть при перетаскивании: подсвеченную строку и линию места
 * вставки. Возвращает стиль подсветки — единый для всех списков.
 */
export function listDragRowStyle(dragKey: string | null, rowKey: string): {
  opacity?: number;
  outline?: string;
  outlineOffset?: string;
  background?: string;
} {
  if (!dragKey) return {};
  if (dragKey !== rowKey) return {};
  return {
    opacity: 0.55,
    outline: '2px solid var(--danger)',
    outlineOffset: '-2px',
  };
}

/** Цвет линии места вставки. */
export const LIST_DROP_INDICATOR_COLOR = 'var(--danger)';
