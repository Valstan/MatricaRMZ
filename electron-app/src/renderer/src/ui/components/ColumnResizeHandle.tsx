import React from 'react';

import type { UseColumnLayoutResult } from '../hooks/useColumnLayout.js';
import { createResizeDrag, type ResizeDrag } from '../utils/columnResizeDrag.js';

/**
 * Ручка ширины колонки (владелец 01.10.2026): потянуть за правый край шапки —
 * колонка станет уже/шире, остальные сожмутся/разъедутся сами (резина таблицы).
 * Двойной клик — сброс колонки на авто. Ручная ширина бьёт авто-замер и едет
 * за оператором через тот же LWW-роуминг, что порядок и скрытые.
 *
 * Клик после drag не должен тогглить сортировку шапки: движение гасится
 * одноразовым перехватчиком (шапка свой onClick не меняет).
 *
 * A1: тяга больше не может повесить программу. Живые ширины идут через
 * rAF-дроссель (не чаще одного setState на кадр, «туда-сюда» не громоздит
 * очередь рендеров), а конец тяги один на все пути: pointerup, pointercancel,
 * потеря capture и blur окна. Повторный finish — noop (машина пуста), поэтому
 * двойное завершение (up + lostpointercapture) безопасно.
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

type LayoutApi = Pick<UseColumnLayoutResult, 'setWidthLive' | 'commitWidths' | 'clearWidth'>;

export function ColumnResizeHandle(props: {
  columnId: string;
  layout: LayoutApi;
}) {
  const dragRef = React.useRef<ResizeDrag | null>(null);
  const layoutRef = React.useRef(props.layout);
  layoutRef.current = props.layout;
  const columnIdRef = React.useRef(props.columnId);
  columnIdRef.current = props.columnId;
  const rafRef = React.useRef(0);
  const pendingRef = React.useRef<number | null>(null);

  function drag(): ResizeDrag {
    if (!dragRef.current) dragRef.current = createResizeDrag();
    return dragRef.current;
  }

  function scheduleLive(width: number) {
    pendingRef.current = width;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const w = pendingRef.current;
      pendingRef.current = null;
      if (w !== null) layoutRef.current.setWidthLive(columnIdRef.current, w);
    });
  }

  function releaseCapture(el: HTMLElement | null, pointerId: number | undefined) {
    try {
      if (el && pointerId !== undefined && el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
      // capture уже нет — завершаем как обычно
    }
  }

  // Стабильная реализация конца тяги в ref: blur-слушатель и unmount-эффект
  // снимают ровно ту функцию, что ставили (иначе слушатель висит).
  const finishDragRef = React.useRef<(el: HTMLElement | null, pointerId: number | undefined) => void>(() => {});

  const onWindowBlur = React.useCallback(() => {
    // Alt-Tab посреди тяги: фиксируем наработанное, залипшего drag нет.
    finishDragRef.current(null, undefined);
  }, []);

  finishDragRef.current = (el, pointerId) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    const moved = drag().finish();
    window.removeEventListener('blur', onWindowBlur);
    if (pending !== null) layoutRef.current.setWidthLive(columnIdRef.current, pending);
    if (moved) {
      layoutRef.current.commitWidths();
      swallowNextClick();
    }
    releaseCapture(el, pointerId);
  };

  function finishDrag(el: HTMLElement | null, pointerId: number | undefined) {
    finishDragRef.current(el, pointerId);
  }

  // Размонтирование посреди тяги: кадров, тяги и слушателей не оставляем.
  React.useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      pendingRef.current = null;
      dragRef.current?.abort();
      window.removeEventListener('blur', onWindowBlur);
    },
    [onWindowBlur],
  );

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
        if (!drag().start(e.clientX, th ? th.getBoundingClientRect().width : 0)) return;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // pointer уже отпущен (перо/тач-грань) — тяга идёт без capture до первого up/cancel
        }
        window.addEventListener('blur', onWindowBlur);
      }}
      onPointerMove={(e) => {
        const w = drag().move(e.clientX);
        if (w !== null) scheduleLive(w);
      }}
      onPointerUp={(e) => finishDrag(e.currentTarget as HTMLElement, e.pointerId)}
      onPointerCancel={(e) => finishDrag(e.currentTarget as HTMLElement, e.pointerId)}
      onLostPointerCapture={() => finishDrag(null, undefined)}
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
