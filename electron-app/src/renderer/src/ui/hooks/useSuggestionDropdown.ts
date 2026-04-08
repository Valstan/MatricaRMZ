import { useEffect, useMemo, useRef, useState } from 'react';
import { rankLookupOptions } from '../utils/searchMatching.js';

type SuggestOption = { id: string; label: string; searchText?: string; hintText?: string };

export function useSuggestionDropdown<T extends SuggestOption>(options: T[]) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(-1);
  const [popupRect, setPopupRect] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
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
      const width = Math.min(rect.width, Math.max(160, viewportW - padding * 2));

      let left = rect.left;
      if (left + width > viewportW - padding) left = viewportW - padding - width;
      if (left < padding) left = padding;

      // Рассчитываем доступное пространство сверху и снизу
      const spaceBelow = Math.max(0, viewportH - rect.bottom - gap - padding);
      const spaceAbove = Math.max(0, rect.top - gap - padding);

      // Если внизу мало места (< 200px), а сверху больше — показываем наверху
      const preferTop = spaceBelow < 200 && spaceAbove > spaceBelow;

      // Высота попапа фиксированная (задаётся из SearchSelect), но ограничиваем viewport
      const maxAvailable = preferTop ? spaceAbove : spaceBelow;
      let top = preferTop ? rect.top - gap : rect.bottom + gap;

      // Ограничиваем в пределах viewport
      if (top < padding) top = padding;
      const effectiveMaxHeight = Math.max(120, maxAvailable);

      setPopupRect({ left, top, width, maxHeight: effectiveMaxHeight });
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
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!filtered.length) {
      setActiveIdx(-1);
      return;
    }
    setActiveIdx((prev) => {
      if (prev < 0) return 0;
      if (prev >= filtered.length) return filtered.length - 1;
      return prev;
    });
  }, [filtered, open]);

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

