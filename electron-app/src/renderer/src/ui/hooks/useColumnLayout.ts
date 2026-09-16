import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  COLUMN_LAYOUT_CHANGE_EVENT,
  clearColumnLayout,
  readColumnLayout,
  writeColumnLayout,
  type ColumnLayoutState,
} from './columnLayoutStore.js';

export type { ColumnLayoutState };

function normalizeOrder(persisted: string[], allColumnIds: string[]): string[] {
  const known = new Set(allColumnIds);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of persisted) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of allColumnIds) {
    if (seen.has(id)) continue;
    result.push(id);
  }
  return result;
}

/**
 * Раскладка из сохранённой записи. Колонка, которой в записи ещё нет (добавлена в коде после
 * того, как оператор настроил список), берёт видимость из `defaultHidden`: иначе каждая новая
 * колонка выезжала бы на экран у всего парка — у любого, кто хоть раз трогал раскладку
 * (поймано смоуком 16.09: три колонки дат в списке двигателей).
 */
export function layoutFromPersisted(
  persisted: ColumnLayoutState | null,
  allColumnIds: string[],
  defaultHidden: string[],
): ColumnLayoutState {
  if (!persisted) return { order: [...allColumnIds], hidden: [...defaultHidden] };
  const known = new Set(allColumnIds);
  const seenBefore = new Set(persisted.order);
  const hidden = new Set(persisted.hidden.filter((id) => known.has(id)));
  for (const id of defaultHidden) if (known.has(id) && !seenBefore.has(id)) hidden.add(id);
  return { order: normalizeOrder(persisted.order, allColumnIds), hidden: Array.from(hidden) };
}

export type UseColumnLayoutResult = {
  order: string[];
  hidden: Set<string>;
  isVisible: (id: string) => boolean;
  setVisible: (id: string, visible: boolean) => void;
  moveColumn: (id: string, direction: -1 | 1) => void;
  resetToDefault: () => void;
};

export function useColumnLayout(
  layoutId: string,
  allColumnIds: string[],
  defaultHidden: string[] = [],
): UseColumnLayoutResult {
  const [state, setState] = useState<ColumnLayoutState>(() => layoutFromPersisted(readColumnLayout(layoutId), allColumnIds, defaultHidden));

  // Re-normalize if the set of columns changes (e.g. new column added in code).
  useEffect(() => {
    setState((prev) => {
      const next = layoutFromPersisted(prev, allColumnIds, defaultHidden);
      if (
        next.order.length === prev.order.length &&
        next.order.every((id, i) => id === prev.order[i]) &&
        next.hidden.length === prev.hidden.length
      ) {
        return prev;
      }
      return next;
    });
  }, [allColumnIds, defaultHidden]);

  useEffect(() => {
    function onChange(ev: Event) {
      const detail = (ev as CustomEvent<{ layoutId?: string }>).detail;
      if (!detail || detail.layoutId !== layoutId) return;
      setState(layoutFromPersisted(readColumnLayout(layoutId), allColumnIds, defaultHidden));
    }
    window.addEventListener(COLUMN_LAYOUT_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(COLUMN_LAYOUT_CHANGE_EVENT, onChange);
  }, [layoutId, allColumnIds, defaultHidden]);

  const hiddenSet = useMemo(() => new Set(state.hidden), [state.hidden]);

  const setVisible = useCallback(
    (id: string, visible: boolean) => {
      setState((prev) => {
        const set = new Set(prev.hidden);
        if (visible) set.delete(id);
        else set.add(id);
        const next = { ...prev, hidden: Array.from(set) };
        writeColumnLayout(layoutId, next);
        return next;
      });
    },
    [layoutId],
  );

  const moveColumn = useCallback(
    (id: string, direction: -1 | 1) => {
      setState((prev) => {
        const idx = prev.order.indexOf(id);
        if (idx < 0) return prev;
        const swapWith = idx + direction;
        if (swapWith < 0 || swapWith >= prev.order.length) return prev;
        const order = [...prev.order];
        const tmp = order[idx]!;
        order[idx] = order[swapWith]!;
        order[swapWith] = tmp;
        const next = { ...prev, order };
        writeColumnLayout(layoutId, next);
        return next;
      });
    },
    [layoutId],
  );

  const resetToDefault = useCallback(() => {
    clearColumnLayout(layoutId);
    setState({ order: [...allColumnIds], hidden: [...defaultHidden] });
  }, [layoutId, allColumnIds, defaultHidden]);

  return {
    order: state.order,
    hidden: hiddenSet,
    isVisible: (id: string) => !hiddenSet.has(id),
    setVisible,
    moveColumn,
    resetToDefault,
  };
}
