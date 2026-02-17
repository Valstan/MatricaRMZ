import React from 'react';

export function DataTable(props: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  wrapStyle?: React.CSSProperties;
}) {
  return (
    <div style={{ overflowX: 'auto', ...(props.wrapStyle ?? {}) }}>
      <table className={`ui-table${props.className ? ` ${props.className}` : ''}`} style={props.style}>
        {props.children}
      </table>
    </div>
  );
}

