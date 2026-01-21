import React from 'react';

import { theme } from '../theme.js';

export function Page(props: {
  title: string;
  right?: React.ReactNode;
  topBanner?: React.ReactNode;
  children: React.ReactNode;
  uiTheme?: 'light' | 'dark';
}) {
  const gradient =
    props.uiTheme === 'light'
      ? `linear-gradient(135deg, #e2e8f0 0%, #f8fafc 45%, #e0f2fe 100%)`
      : `linear-gradient(135deg, ${theme.colors.appBgFrom} 0%, ${theme.colors.appBgVia} 45%, ${theme.colors.appBgTo} 100%)`;
  return (
    <div
      style={{
        height: '100vh',
        background: gradient,
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
        {props.topBanner ? <div style={{ marginTop: 8 }}>{props.topBanner}</div> : null}
        <div style={{ marginTop: 10, flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>{props.children}</div>
      </div>
    </div>
  );
}



