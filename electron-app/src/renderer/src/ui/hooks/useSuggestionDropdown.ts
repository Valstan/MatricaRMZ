import { useEffect, useMemo, useRef, useState } from 'react';
import { rankLookupOptions } from '../utils/searchMatching.js';

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

export function useSuggestionDropdown<T extends SuggestOption>(options: T[]) {
  const [open, setOpen] = useState(false);
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

  return {
    rootRef,
    popupRef,
    listRef,
    open,
    setOpen,
    closeDropdown,
    query,
    setQuery,
    filtered,
    activeIdx,
    setActiveIdx,
    popupRect,
  };
}

