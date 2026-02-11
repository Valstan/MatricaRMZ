import React from 'react';

export function EntityCardShell(props: {
  title: string;
  actions?: React.ReactNode;
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          paddingBottom: 8,
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ margin: 0, flex: '1 1 320px', minWidth: 0, fontSize: 20, fontWeight: 800 }}>{props.title}</div>
        {props.actions}
        {props.status}
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>{props.children}</div>
    </div>
  );
}
