import React from 'react';

import { theme } from '../theme.js';

export function Page(props: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: `linear-gradient(135deg, ${theme.colors.appBgFrom} 0%, ${theme.colors.appBgVia} 45%, ${theme.colors.appBgTo} 100%)`,
        padding: 18,
      }}
    >
      <div
        style={{
          fontFamily: 'system-ui',
          maxWidth: 1200,
          margin: '0 auto',
          borderRadius: 18,
          border: `1px solid ${theme.colors.border}`,
          background: theme.colors.surface,
          boxShadow: '0 30px 70px rgba(0,0,0,0.25)',
          padding: 16,
        }}
      >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: 22, color: theme.colors.text }}>{props.title}</h1>
        </div>
        {props.right}
      </div>
      <div style={{ marginTop: 12 }}>{props.children}</div>
      </div>
    </div>
  );
}


