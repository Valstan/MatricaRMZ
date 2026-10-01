import React from 'react';

import type { UseColumnLayoutResult } from '../hooks/useColumnLayout.js';

/**
 * Ручка ширины колонки (владелец 01.10.2026): потянуть за правый край шапки —
 * колонка станет уже/шире, остальные сожмутся/разъедутся сами (резина таблицы).
 * Двойной клик — сброс колонки на авто. Ручная ширина бьёт авто-замер и едет
 * за оператором через тот же LWW-роуминг, что порядок и скрытые.
 *
 * Клик после drag не должен тогглить сортировку шапки: движение гасится
 * одноразовым перехватчиком (шапка свой onClick не меняет).
 */
/**
 * Якорь для ручки ресайза. Раскладывать ПЕРВЫМ в стиле th: собственный
 * position страницы (sticky) побеждает.
 */
export function manualThAnchor(): React.CSSProperties {
  return { position: 'relative' };
}

/**
 * Ручная ширина шапки. Раскладывать ПОСЛЕДНЕЙ (после статичной ширины колонки).
 * Работает в паре с fixed-раскладкой таблицы (см. VirtualTable fixedLayout)
 * и правилом `[data-manual-w]` в global.css: single-mode прибивает th/td
 * через `width: auto !important`, и голый инлайн против него бессилен.
 */
export function manualWidth(width: number | null, fallback?: number): React.CSSProperties {
  const w = width ?? fallback ?? null;
  if (w === null) return {};
  const out: React.CSSProperties = { width: w };
  (out as Record<string, string>)['--col-manual-w'] = `${w}px`;
  return out;
}

/** Маркер ручной ширины для CSS-правила (без него переменная не применится). */
export function manualWidthAttr(width: number | null): { 'data-manual-w'?: number } {
  return width === null ? {} : { 'data-manual-w': width };
}

export function ColumnResizeHandle(props: {
  columnId: string;
  layout: Pick<UseColumnLayoutResult, 'setWidthLive' | 'commitWidths' | 'clearWidth'>;
}) {
  const drag = React.useRef<{ startX: number; startW: number; moved: boolean } | null>(null);

  function swallowNextClick() {
    const swallow = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      window.removeEventListener('click', swallow, true);
    };
    window.addEventListener('click', swallow, true);
    // Страховка: если клик так и не пришёл, слушатель не висит вечно.
    setTimeout(() => window.removeEventListener('click', swallow, true), 500);
  }

  return (
    <span
      data-col-resize={props.columnId}
      title="Потянуть — ширина колонки (двойной клик — авто)"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        props.layout.clearWidth(props.columnId);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const th = (e.currentTarget as HTMLElement).parentElement;
        drag.current = { startX: e.clientX, startW: th ? th.getBoundingClientRect().width : 0, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.startX;
        if (Math.abs(dx) > 3) d.moved = true;
        if (d.moved) props.layout.setWidthLive(props.columnId, d.startW + dx);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved) {
          props.layout.commitWidths();
          swallowNextClick();
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      style={{
        position: 'absolute',
        top: 0,
        right: -5,
        bottom: 0,
        width: 10,
        cursor: 'col-resize',
        zIndex: 3,
        touchAction: 'none',
      }}
    />
  );
}
