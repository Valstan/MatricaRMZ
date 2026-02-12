import React from 'react';

function splitAlternating<T>(items: T[]): { left: T[]; right: T[] } {
  const left: T[] = [];
  const right: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    (i % 2 === 0 ? left : right).push(item);
  }
  return { left, right };
}

export function TwoColumnList<T>(props: {
  items: T[];
  enabled: boolean;
  minColumnWidthPx?: number;
  gapPx?: number;
  renderColumn: (items: T[], col: 'left' | 'right') => React.ReactNode;
}) {
  const gap = props.gapPx ?? 10;
  if (!props.enabled) return <>{props.renderColumn(props.items, 'left')}</>;
  const { left, right } = splitAlternating(props.items);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap }}>
      <div>{props.renderColumn(left, 'left')}</div>
      <div>{props.renderColumn(right, 'right')}</div>
    </div>
  );
}


