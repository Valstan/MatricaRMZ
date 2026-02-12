import React from 'react';

function splitInHalves<T>(items: T[]): { left: T[]; right: T[] } {
  const safe = items.filter((item) => item !== undefined);
  const splitAt = Math.ceil(safe.length / 2);
  return {
    left: safe.slice(0, splitAt),
    right: safe.slice(splitAt),
  };
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
  const { left, right } = splitInHalves(props.items);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap }}>
      <div>{props.renderColumn(left, 'left')}</div>
      <div>{props.renderColumn(right, 'right')}</div>
    </div>
  );
}


