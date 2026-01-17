import React from 'react';

import { theme } from '../theme.js';

export function Page(props: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      style={{
        height: '100vh',
        background: `linear-gradient(135deg, ${theme.colors.appBgFrom} 0%, ${theme.colors.appBgVia} 45%, ${theme.colors.appBgTo} 100%)`,
        padding: 10,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          fontFamily: 'system-ui',
          width: '100%',
          height: '100%',
          border: `1px solid ${theme.colors.border}`,
          background: theme.colors.surface,
          boxShadow: '0 18px 46px rgba(0,0,0,0.22)',
          padding: 10,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 800,
                color: theme.colors.text,
                lineHeight: 1.15,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={props.title}
            >
              {props.title}
            </h1>
          </div>
          {props.right}
        </div>
        <div style={{ marginTop: 10, flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>{props.children}</div>
      </div>
    </div>
  );
}



