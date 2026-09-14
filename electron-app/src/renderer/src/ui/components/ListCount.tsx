import React from 'react';

import { listCountLabel } from '../utils/listCount';

/**
 * Строка над таблицей: «Всего: N · Показано: M». Ставится НАД скролл-контейнером,
 * не в `PageToolbar` — тулбар сворачивает лишнее в меню «⋯», а счётчик обязан быть виден
 * всегда (владелец 15.09.2026). `extra` — хвост страницы (подсказки, режимы).
 */
export function ListCount(props: { total: number | null | undefined; shown: number; extra?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      className="muted list-count"
      data-list-count
      style={{ fontSize: 12, margin: '4px 0 2px', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', ...props.style }}
    >
      <span style={{ whiteSpace: 'nowrap' }}>{listCountLabel(props.total, props.shown)}</span>
      {props.extra}
    </div>
  );
}
