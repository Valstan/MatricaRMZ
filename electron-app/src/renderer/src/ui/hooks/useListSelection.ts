import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useListSelection(orderedIds: string[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);

  const selectedCount = selectedIds.size;

  const selectedInOrder = useMemo(() => orderedIds.filter((id) => selectedIds.has(id)), [orderedIds, selectedIds]);

  const clearSelection = () => {
    setSelectedIds(new Set());
    setAnchorId(null);
  };

  const isSelected = (id: string) => selectedIds.has(id);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchorId((prev) => prev ?? id);
    setCursorId(id);
  };

  const selectOnly = (id: string) => {
    setSelectedIds(new Set([id]));
    setAnchorId(id);
    setCursorId(id);
  };

  const addRangeTo = (targetId: string) => {
    const ids = orderedIds;
    if (!ids.length) return;
    const baseId = anchorId ?? cursorId ?? targetId;
    const fromIdx = ids.indexOf(baseId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) {
      toggleSelect(targetId);
      return;
    }
    const [start, end] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (let i = start; i <= end; i += 1) next.add(ids[i]!);
      return next;
    });
    setAnchorId(baseId);
    setCursorId(targetId);
  };

  const handleShiftArrow = (dir: -1 | 1) => {
    if (!orderedIds.length) return false;
    const baseId = cursorId ?? selectedInOrder[selectedInOrder.length - 1] ?? orderedIds[0] ?? '';
    let idx = orderedIds.indexOf(baseId);
    if (idx < 0) idx = 0;
    const nextIdx = Math.max(0, Math.min(orderedIds.length - 1, idx + dir));
    const nextId = orderedIds[nextIdx]!;
    addRangeTo(nextId);
    return true;
  };

  const onRowPrimaryAction = (id: string) => {
    setCursorId(id);
    if (selectedCount > 0 && !selectedIds.has(id)) clearSelection();
  };

  const onRowContextMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCursorId(id);
    if (e.shiftKey) {
      toggleSelect(id);
      return { openMenu: false, targetIds: [] as string[], bulk: false };
    }
    const bulk = selectedCount > 0 && selectedIds.has(id);
    const targetIds = bulk ? selectedInOrder : [id];
    return { openMenu: true, targetIds, bulk };
  };

  useEffect(() => {
    if (selectedCount <= 0) return;
    const onDocDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-list-context-menu="true"]')) return;
      if (target.closest('[data-list-selected="true"]')) return;
      clearSelection();
    };
    document.addEventListener('mousedown', onDocDown, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown, true);
    };
  }, [selectedCount]);

  useEffect(() => {
    if (selectedCount <= 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.shiftKey && e.key === 'ArrowDown') {
        e.preventDefault();
        handleShiftArrow(1);
        return;
      }
      if (e.shiftKey && e.key === 'ArrowUp') {
        e.preventDefault();
        handleShiftArrow(-1);
        return;
      }
      if (e.key === 'Shift') return;
      if (!e.shiftKey) clearSelection();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [selectedCount, orderedIds, selectedInOrder, cursorId, anchorId]);

  return {
    selectedIds,
    selectedInOrder,
    selectedCount,
    isSelected,
    clearSelection,
    toggleSelect,
    selectOnly,
    onRowPrimaryAction,
    onRowContextMenu,
  };
}

