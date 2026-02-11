import React from 'react';

export function RowActions(props: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}
