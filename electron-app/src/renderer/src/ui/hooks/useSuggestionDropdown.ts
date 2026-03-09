import { useEffect, useMemo, useRef, useState } from 'react';

type SuggestOption = { id: string; label: string };

function norm(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'`.,;:!?()[\]{}<>/\\|+-]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function useSuggestionDropdown<T extends SuggestOption>(options: T[]) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(-1);
  const [popupRect, setPopupRect] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = norm(query);
    if (!q) return options;
    return options.filter((o) => norm(o.label).includes(q) || norm(o.id).includes(q));
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
      const popupHeight = popupRef.current?.getBoundingClientRect().height ?? 300;

      let left = rect.left;
      if (left + width > viewportW - padding) left = viewportW - padding - width;
      if (left < padding) left = padding;

      const spaceBelow = Math.max(0, viewportH - rect.bottom - gap - padding);
      const spaceAbove = Math.max(0, rect.top - gap - padding);
      const preferTop = spaceBelow < Math.min(220, popupHeight) && spaceAbove > spaceBelow;
      const maxHeight = Math.max(120, Math.min(320, preferTop ? spaceAbove : spaceBelow));
      const shownHeight = Math.min(popupHeight, maxHeight);
      let top = preferTop ? rect.top - shownHeight - gap : rect.bottom + gap;
      if (top < padding) top = padding;
      if (top + shownHeight > viewportH - padding) top = viewportH - padding - shownHeight;

      setPopupRect({ left, top, width, maxHeight });
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

