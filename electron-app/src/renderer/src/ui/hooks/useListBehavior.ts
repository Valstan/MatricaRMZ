import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';

export type SortDir = 'asc' | 'desc';

const MEMORY = new Map<string, string>();

function readStoredState<T extends Record<string, unknown>>(storageKey: string, defaults: T): T {
  try {
    const fromMemory = MEMORY.get(storageKey);
    const raw = fromMemory ?? window.sessionStorage.getItem(storageKey);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    return { ...defaults, ...(parsed as T) };
  } catch {
    return defaults;
  }
}

function writeStoredState(storageKey: string, value: unknown) {
  try {
    const raw = JSON.stringify(value);
    MEMORY.set(storageKey, raw);
    window.sessionStorage.setItem(storageKey, raw);
  } catch {
    // ignore persistence errors
  }
}

export function useListUiState<T extends Record<string, unknown>>(storageKey: string, defaults: T) {
  const [state, setState] = useState<T>(() => readStoredState(storageKey, defaults));

  useEffect(() => {
    writeStoredState(storageKey, state);
  }, [storageKey, state]);

  function patchState(patch: Record<string, unknown>) {
    setState((prev) => ({ ...prev, ...(patch as Partial<T>) }));
  }

  return { state, setState, patchState };
}

export function usePersistedScrollTop(storageKey: string) {
  const storeKey = `${storageKey}::scroll`;
  const { state, patchState } = useListUiState<{ top: number }>(storeKey, { top: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, Number(state.top ?? 0));
    restoredRef.current = true;
  }, [state.top]);

  return {
    containerRef,
    onScroll: (e: UIEvent<HTMLDivElement>) => patchState({ top: e.currentTarget.scrollTop }),
  };
}

export function toggleSort<TKey extends string>(
  currentKey: TKey,
  currentDir: SortDir,
  nextKey: TKey,
): { sortKey: TKey; sortDir: SortDir } {
  if (currentKey === nextKey) return { sortKey: currentKey, sortDir: currentDir === 'asc' ? 'desc' : 'asc' };
  return { sortKey: nextKey, sortDir: 'asc' };
}

export function sortArrow<TKey extends string>(currentKey: TKey, currentDir: SortDir, key: TKey) {
  if (currentKey !== key) return '';
  return currentDir === 'asc' ? '▲' : '▼';
}

function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  const mult = dir === 'asc' ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * mult;
  return String(a ?? '').localeCompare(String(b ?? ''), 'ru') * mult;
}

export function useSortedItems<T, TKey extends string>(
  items: T[],
  sortKey: TKey,
  sortDir: SortDir,
  getter: (item: T, key: TKey) => unknown,
  tieBreaker?: (item: T) => string,
) {
  return useMemo(() => {
    const list = [...items];
    list.sort((a, b) => {
      const primary = compareValues(getter(a, sortKey), getter(b, sortKey), sortDir);
      if (primary !== 0) return primary;
      if (!tieBreaker) return 0;
      return tieBreaker(a).localeCompare(tieBreaker(b), 'ru');
    });
    return list;
  }, [items, sortKey, sortDir, getter, tieBreaker]);
}

