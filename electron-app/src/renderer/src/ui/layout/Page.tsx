import React from 'react';

export function Page(props: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'system-ui', padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>{props.title}</h1>
        </div>
        {props.right}
      </div>
      <div style={{ marginTop: 12 }}>{props.children}</div>
    </div>
  );
}


