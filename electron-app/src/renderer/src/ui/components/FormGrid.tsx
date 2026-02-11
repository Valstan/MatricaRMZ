import React from 'react';

export function FormGrid(props: {
  children: React.ReactNode;
  columns?: string;
  gap?: number;
  minWidth?: number;
  style?: React.CSSProperties;
}) {
  const columns = props.columns ?? 'repeat(auto-fit, minmax(260px, 1fr))';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: columns,
        gap: props.gap ?? 10,
        minWidth: props.minWidth ?? 0,
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}
