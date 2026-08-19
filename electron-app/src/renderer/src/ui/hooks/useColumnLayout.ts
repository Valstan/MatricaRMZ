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
  const [state, setState] = useState<ColumnLayoutState>(() => {
    const persisted = readColumnLayout(layoutId);
    if (persisted) {
      return {
        order: normalizeOrder(persisted.order, allColumnIds),
        hidden: persisted.hidden.filter((id) => allColumnIds.includes(id)),
      };
    }
    return { order: [...allColumnIds], hidden: [...defaultHidden] };
  });

  // Re-normalize if the set of columns changes (e.g. new column added in code).
  useEffect(() => {
    setState((prev) => {
      const nextOrder = normalizeOrder(prev.order, allColumnIds);
      const knownSet = new Set(allColumnIds);
      const nextHidden = prev.hidden.filter((id) => knownSet.has(id));
      if (
        nextOrder.length === prev.order.length &&
        nextOrder.every((id, i) => id === prev.order[i]) &&
        nextHidden.length === prev.hidden.length
      ) {
        return prev;
      }
      return { order: nextOrder, hidden: nextHidden };
    });
  }, [allColumnIds]);

  useEffect(() => {
    function onChange(ev: Event) {
      const detail = (ev as CustomEvent<{ layoutId?: string }>).detail;
      if (!detail || detail.layoutId !== layoutId) return;
      const persisted = readColumnLayout(layoutId);
      if (persisted) {
        setState({
          order: normalizeOrder(persisted.order, allColumnIds),
          hidden: persisted.hidden.filter((id) => allColumnIds.includes(id)),
        });
      } else {
        setState({ order: [...allColumnIds], hidden: [...defaultHidden] });
      }
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
