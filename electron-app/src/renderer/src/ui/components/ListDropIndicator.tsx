import React from 'react';

import { LIST_DROP_INDICATOR_COLOR } from '../utils/listDragVisual.js';

/**
 * Линия места вставки при перетаскивании строки (промт КАРМАНА #67).
 *
 * До сих пор оператор тащил строку и не видел, куда она встанет: строки не раздвигались,
 * места вставки не было. Линия — общая для всех списков, рисуется поверх таблицы.
 */
export function ListDropIndicator(props: { position: 'before' | 'after' }) {
  return (
    <div
      data-list-drop-indicator="true"
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        height: 2,
        background: LIST_DROP_INDICATOR_COLOR,
        pointerEvents: 'none',
        zIndex: 5,
        ...(props.position === 'before' ? { top: 0 } : { bottom: 0 }),
      }}
    />
  );
}
