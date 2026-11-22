import { useCallback, useEffect, useRef, useState } from 'react';

import { collectLassoKeys, lassoRectStyle, normalizeLassoRect, type LassoRect, type Point } from '../utils/listLasso.js';

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return true;
  // Ручка перетаскивания и чекбокс строки — не начала рамки: клик по ним должен
  // делать своё дело, а не включать режим контура.
  return Boolean(target.closest('[data-list-handle="true"]'));
}

/**
 * Выделение контуром (Ctrl + рамка) — общий слой для всех списков (промт КАРМАНА #67).
 *
 * Работает по маркеру строки `data-list-row="true"` + `data-list-row-key`, поэтому
 * список подключается к контуру без знания о его геометрии: достаточно отметить строки.
 * Ctrl+клик по чекбоксу остаётся чекбоксом — рамка начинается только на «пустом» месте
 * списка (мимо интерактивных элементов), иначе выделение контуром ломало бы обычный
 * выбор строк.
 */
export function useListLasso(opts: {
  enabled: boolean;
  onSelect: (keys: string[]) => void;
}) {
  const [rect, setRect] = useState<LassoRect | null>(null);
  const startRef = useRef<Point | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  const collectRows = useCallback(() => {
    const root = rootRef.current;
    const scope = root ?? document;
    return Array.from(scope.querySelectorAll<HTMLElement>('[data-list-row="true"][data-list-row-key]')).map((row) => {
      const box = row.getBoundingClientRect();
      return {
        key: row.getAttribute('data-list-row-key') ?? '',
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      };
    });
  }, []);

  const finish = useCallback(
    (end: Point) => {
      const start = startRef.current;
      startRef.current = null;
      setRect(null);
      if (!start) return;
      const box = normalizeLassoRect(start, end);
      // Щелчок без протяжки — это обычный клик, не рамка.
      if (box.right - box.left < 4 && box.bottom - box.top < 4) return;
      const keys = collectLassoKeys(box, collectRows());
      if (keys.length) opts.onSelect(keys);
    },
    [collectRows, opts],
  );

  useEffect(() => {
    if (!opts.enabled) return;
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0 || !event.ctrlKey) return;
      if (isInteractiveTarget(event.target)) return;
      const target = event.target as HTMLElement | null;
      const root = target?.closest('[data-list-root="true"]') as HTMLElement | null;
      if (!root) return;
      rootRef.current = root;
      startRef.current = { x: event.clientX, y: event.clientY };
      setRect(normalizeLassoRect({ x: event.clientX, y: event.clientY }, { x: event.clientX, y: event.clientY }));
      event.preventDefault();
    };
    const onMove = (event: MouseEvent) => {
      if (!startRef.current) return;
      setRect(normalizeLassoRect(startRef.current, { x: event.clientX, y: event.clientY }));
    };
    const onUp = (event: MouseEvent) => {
      if (!startRef.current) return;
      finish({ x: event.clientX, y: event.clientY });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !startRef.current) return;
      startRef.current = null;
      setRect(null);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [opts.enabled, finish]);

  return {
    /** Прямоугольник рамки для отрисовки (или null — рамки нет). */
    lassoRect: rect,
    lassoStyle: rect ? lassoRectStyle(rect) : null,
  };
}
