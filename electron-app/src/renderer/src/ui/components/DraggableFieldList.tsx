import React, { useMemo, useState } from 'react';

type DragState = {
  isDragging: boolean;
  isOver: boolean;
};

type DragHandleProps = React.HTMLAttributes<HTMLDivElement> & {
  draggable: boolean;
};

type DragItemProps = React.HTMLAttributes<HTMLDivElement>;

export function DraggableFieldList<T>(props: {
  items: T[];
  getKey: (item: T) => string;
  canDrag?: boolean;
  onReorder: (next: T[]) => void;
  renderItem: (item: T, itemProps: DragItemProps, dragHandleProps: DragHandleProps, state: DragState) => React.ReactNode;
}) {
  const { items, getKey, onReorder, renderItem } = props;
  const canDrag = props.canDrag ?? true;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, idx) => map.set(getKey(item), idx));
    return map;
  }, [items, getKey]);

  function move(from: number, to: number) {
    if (from === to) return;
    const next = [...items];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    onReorder(next);
  }

  function handleDragStart(item: T) {
    if (!canDrag) return;
    const idx = indexByKey.get(getKey(item));
    if (idx == null) return;
    setDragIndex(idx);
  }

  function handleDragOver(item: T, e: React.DragEvent) {
    if (!canDrag) return;
    e.preventDefault();
    const idx = indexByKey.get(getKey(item));
    if (idx == null) return;
    setOverIndex(idx);
  }

  function handleDrop(item: T) {
    if (!canDrag) return;
    const idx = indexByKey.get(getKey(item));
    if (idx == null || dragIndex == null) return;
    move(dragIndex, idx);
  }

  function handleDragEnd() {
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {items.map((item, idx) => {
        const isDragging = dragIndex === idx;
        const isOver = overIndex === idx && dragIndex !== null && dragIndex !== idx;
        const itemProps: DragItemProps = {
          onDragOver: (e) => handleDragOver(item, e as any),
          onDrop: () => handleDrop(item),
          onDragEnd: () => handleDragEnd(),
        };
        const dragHandleProps: DragHandleProps = {
          draggable: canDrag,
          onDragStart: () => handleDragStart(item),
          onDragEnd: () => handleDragEnd(),
          style: {
            cursor: canDrag ? 'grab' : 'default',
          },
        };
        return <React.Fragment key={getKey(item)}>{renderItem(item, itemProps, dragHandleProps, { isDragging, isOver })}</React.Fragment>;
      })}
    </div>
  );
}
