import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rankLookupOptions } from '../utils/searchMatching.js';

/** Автоскрытие выпадашки после паузы без взаимодействия (решение владельца: как на экране входа — везде). */
const DEFAULT_AUTO_HIDE_MS = 3000;

type SuggestOption = { id: string; label: string; searchText?: string; hintText?: string };

/** Ширина строк подписи/подсказки (приближённо к SearchSelect), плюс отступы и бейдж. */
const MEASURE_LABEL_FONT = '600 14px system-ui, "Segoe UI", sans-serif';
const MEASURE_HINT_FONT = '400 11px system-ui, "Segoe UI", sans-serif';

function estimateSuggestListContentWidth(items: ReadonlyArray<{ label: string; hintText?: string }>): number {
  if (items.length === 0) return 220;
  let maxPx = 200;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const limit = Math.min(items.length, 500);
      for (let i = 0; i < limit; i++) {
        const o = items[i];
        const label = String(o?.label ?? '');
        const hint = String(o?.hintText ?? '');
        ctx.font = MEASURE_LABEL_FONT;
        maxPx = Math.max(maxPx, ctx.measureText(label).width);
        if (hint) {
          ctx.font = MEASURE_HINT_FONT;
          maxPx = Math.max(maxPx, ctx.measureText(hint).width);
        }
      }
    }
  }
  return Math.ceil(maxPx) + 140;
}

export function useSuggestionDropdown<T extends SuggestOption>(
  options: T[],
  opts?: { autoHideMs?: number },
) {
  const autoHideMs = opts?.autoHideMs ?? DEFAULT_AUTO_HIDE_MS;
  const [open, setOpen] = useState(false);
  // True when the dropdown closed itself on inactivity (auto-hide), as opposed to
  // an explicit close (pick / click-away / Escape). Consumers use this to KEEP the
  // user's typed text on auto-hide instead of reverting the input to the selected
  // label — re-typing after a thinking pause is hostile.
  const [autoHidden, setAutoHidden] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(-1);
  const [popupRect, setPopupRect] = useState<
    | { left: number; width: number; maxHeight: number; placement: 'below'; top: number }
    | { left: number; width: number; maxHeight: number; placement: 'above'; bottom: number }
    | null
  >(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Scroll the active row into view ONLY for keyboard navigation. Mouse hover also
  // sets activeIdx (for highlight), but scrolling on hover makes the row jump out
  // from under the cursor → another hover → scroll → jitter. Keyboard nav sets this
  // ref before moving; the scroll effect honours it once and clears it.
  const scrollOnActiveRef = useRef(false);
  const setActiveByKeyboard = useCallback((updater: number | ((prev: number) => number)) => {
    scrollOnActiveRef.current = true;
    setActiveIdx(updater);
  }, []);

  const filtered = useMemo(() => {
    return rankLookupOptions(options, query);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (rootRef.current?.contains(target) || popupRef.current?.contains(target))) return;
      setOpen(false);
      setActiveIdx(-1);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let rafId = 0;
    const update = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 6;
      const padding = 8;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const contentW = estimateSuggestListContentWidth(filtered);
      const width = Math.min(Math.max(rect.width, contentW, 160), viewportW - padding * 2);

      let left = rect.left;
      if (left + width > viewportW - padding) left = viewportW - padding - width;
      if (left < padding) left = padding;

      // Рассчитываем доступное пространство сверху и снизу
      const spaceBelow = Math.max(0, viewportH - rect.bottom - gap - padding);
      const spaceAbove = Math.max(0, rect.top - gap - padding);

      // Если до нижнего края viewport мало места (< 250px), а сверху больше — якорим попап сверху поля
      const preferTop = spaceBelow < 250 && spaceAbove > spaceBelow;

      const maxAvailable = preferTop ? spaceAbove : spaceBelow;
      const effectiveMaxHeight = Math.max(120, maxAvailable);

      if (preferTop) {
        const bottom = viewportH - rect.top + gap;
        setPopupRect({ left, width, maxHeight: effectiveMaxHeight, placement: 'above', bottom });
      } else {
        let top = rect.bottom + gap;
        if (top < padding) top = padding;
        setPopupRect({ left, width, maxHeight: effectiveMaxHeight, placement: 'below', top });
      }
    };
    update();
    rafId = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, filtered]);

  useEffect(() => {
    if (!open) return;
    if (!filtered.length) setActiveIdx(-1);
  }, [filtered.length, open]);

  useEffect(() => {
    if (!open || activeIdx < 0) return;
    // Only keyboard nav scrolls; hover-driven activeIdx changes must not move the list.
    if (!scrollOnActiveRef.current) return;
    scrollOnActiveRef.current = false;
    const host = listRef.current;
    if (!host) return;
    const el = host.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null;
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    const viewTop = host.scrollTop;
    const viewBottom = viewTop + host.clientHeight;
    if (top < viewTop) host.scrollTop = top;
    else if (bottom > viewBottom) host.scrollTop = bottom - host.clientHeight;
  }, [activeIdx, open]);

  function closeDropdown() {
    setOpen(false);
    setActiveIdx(-1);
  }

  // ---- Автоскрытие: открытая выпадашка закрывается через autoHideMs без
  // взаимодействия (ввод, стрелки, hover/скролл по списку — сбрасывают таймер).
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpAutoHide = useCallback(() => {
    if (!autoHideMs) return;
    if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = setTimeout(() => {
      setOpen(false);
      setActiveIdx(-1);
      setAutoHidden(true);
    }, autoHideMs);
  }, [autoHideMs]);

  // Any (re)open clears the auto-hidden marker so explicit-close behaviour resumes.
  useEffect(() => {
    if (open) setAutoHidden(false);
  }, [open]);

  useEffect(() => {
    if (!autoHideMs) return undefined;
    if (!open) {
      if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
      return undefined;
    }
    bumpAutoHide();
    return () => {
      if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    };
  }, [open, autoHideMs, bumpAutoHide]);

  // Ввод текста и перемещение по списку (стрелки / hover ставит activeIdx) — взаимодействие.
  useEffect(() => {
    if (open) bumpAutoHide();
  }, [query, activeIdx, open, bumpAutoHide]);

  // Движение мыши / колесо над попапом — взаимодействие (попап в портале, отдельные слушатели).
  useEffect(() => {
    if (!open || !autoHideMs) return undefined;
    const el = popupRef.current;
    if (!el) return undefined;
    const bump = () => bumpAutoHide();
    el.addEventListener('mousemove', bump);
    el.addEventListener('wheel', bump);
    return () => {
      el.removeEventListener('mousemove', bump);
      el.removeEventListener('wheel', bump);
    };
  }, [open, autoHideMs, bumpAutoHide, popupRect]);

  return {
    rootRef,
    popupRef,
    listRef,
    open,
    setOpen,
    autoHidden,
    closeDropdown,
    bumpAutoHide,
    query,
    setQuery,
    filtered,
    activeIdx,
    setActiveIdx,
    setActiveByKeyboard,
    popupRect,
  };
}

