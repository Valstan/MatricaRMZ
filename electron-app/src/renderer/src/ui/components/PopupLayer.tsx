import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Слой всплывающих меню: портал в `document.body` поверх всего окна.
 *
 * Зачем портал, а не просто большой `z-index` (владелец 18.09.2026: «всплывающее меню
 * уходит на задний план, под список»): `z-index` действует ТОЛЬКО внутри своего
 * контекста наложения. Меню кнопочной панели живёт внутри `.v3-menu-overlay`
 * (`z-index: 40`), меню тулбара — внутри липкой шапки (`z-index: 8`), меню строки
 * списка — внутри вкладки; любое число внутри такого предка не поднимает меню выше
 * САМОГО предка. Плюс на планшете вокруг списков стоят прокручиваемые контейнеры
 * (`-webkit-overflow-scrolling: touch`), а WebView с включённым pinch-zoom
 * (`MainActivity.java`) складывает их в отдельные слои композитора — там даже
 * `position: fixed` рисуется внутри слоя предка.
 *
 * Портал в `body` снимает зависимость от предков целиком: меню больше не внутри ни
 * одного контекста наложения, ни одного `overflow` и ни одного слоя прокрутки.
 * Тем же способом уже живут выпадающие списки подбора (`SearchSelect` и родня).
 */

/**
 * Этаж всплывающих меню. Выше всего, что есть в приложении: диалоги 1000–4100,
 * глобальный поиск 6000, смена аккаунта 12000, `!important`-слой global.css 12000.
 * Меню обязано перекрывать их все — оно вызвано поверх того, что уже открыто.
 */
export const POPUP_Z_INDEX = 13000;

export function PopupLayer(props: { children: React.ReactNode }) {
  if (typeof document === 'undefined') return null;
  return createPortal(props.children, document.body);
}

type AnchoredOptions = {
  /** К какому краю кнопки прижимать меню. */
  align?: 'left' | 'right';
  /** Зазор между кнопкой и меню. */
  gap?: number;
  /** Растянуть меню по ширине кнопки (фильтры статусов). */
  matchAnchorWidth?: boolean;
};

export type AnchoredPopup = {
  /** Ref на сам элемент меню — по нему считается размер. */
  ref: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  /** Сам узел меню: нужен проверке «клик мимо» — в портале он уже НЕ внутри кнопки. */
  node: HTMLElement | null;
};

/**
 * Координаты меню, привязанного к кнопке, в СИСТЕМЕ ОКНА (`position: fixed`).
 *
 * После переезда в портал «под кнопкой» уже не получается версткой — предка больше нет.
 * Считаем по факту: прямоугольник кнопки + измеренный размер меню, с зажимом в границы
 * окна (это же делал прежний `useViewportClamp`: у края экрана меню уезжало за кадр).
 */
export function useAnchoredPopup(
  open: boolean,
  anchor: HTMLElement | null,
  opts: AnchoredOptions = {},
): AnchoredPopup {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const ref = useCallback((el: HTMLElement | null) => setNode(el), []);

  const measure = useCallback(() => {
    if (!open || !anchor || !node) return;
    const margin = 8;
    const gap = opts.gap ?? 4;
    const a = anchor.getBoundingClientRect();
    const m = node.getBoundingClientRect();
    const width = opts.matchAnchorWidth ? a.width : m.width;

    let left = opts.align === 'right' ? a.right - width : a.left;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
    if (left < margin) left = margin;

    // Под кнопкой, а если внизу не помещается — над ней (у планшета экран низкий).
    const belowTop = a.bottom + gap;
    const spaceBelow = window.innerHeight - belowTop - margin;
    const spaceAbove = a.top - gap - margin;
    const putAbove = m.height > spaceBelow && spaceAbove > spaceBelow;
    const top = putAbove ? Math.max(margin, a.top - gap - m.height) : belowTop;
    const maxHeight = Math.max(80, putAbove ? spaceAbove : spaceBelow);

    setStyle({
      position: 'fixed',
      left: Math.round(left),
      top: Math.round(top),
      zIndex: POPUP_Z_INDEX,
      maxHeight,
      ...(opts.matchAnchorWidth ? { width: Math.round(width) } : {}),
    });
  }, [open, anchor, node, opts.align, opts.gap, opts.matchAnchorWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: 'hidden' });
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onChange = () => measure();
    window.addEventListener('resize', onChange);
    // Прокрутка любого контейнера двигает кнопку — меню обязано ехать за ней.
    window.addEventListener('scroll', onChange, true);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [open, measure]);

  return { ref, style, node };
}
