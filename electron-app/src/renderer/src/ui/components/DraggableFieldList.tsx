import React from 'react';

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
  const { items, getKey, renderItem } = props;

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {items.map((item) => {
        const itemProps: DragItemProps = {};
        const dragHandleProps: DragHandleProps = {
          draggable: false,
          style: {
            cursor: 'default',
          },
        };
        return <React.Fragment key={getKey(item)}>{renderItem(item, itemProps, dragHandleProps, { isDragging: false, isOver: false })}</React.Fragment>;
      })}
    </div>
  );
}
