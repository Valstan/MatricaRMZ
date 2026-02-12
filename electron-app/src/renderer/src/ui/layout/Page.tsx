import React from 'react';

import { theme } from '../theme.js';

export function Page(props: {
  title: string;
  center?: React.ReactNode;
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
        padding: 0,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          fontFamily: 'system-ui',
          width: '100%',
          height: '100%',
          border: 'none',
          background: theme.colors.surface,
          boxShadow: 'none',
          padding: 0,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: '0 0 auto',
            padding: '6px 8px',
            background: '#0b2d63',
            color: '#ffffff',
            borderBottom: '1px solid rgba(255,255,255,0.14)',
          }}
        >
          <div style={{ flex: '0 1 42%', minWidth: 180 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 800,
                color: '#ffffff',
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
          {props.center ? <div style={{ flex: '1 1 auto', minWidth: 0, color: '#ffffff' }}>{props.center}</div> : null}
          {props.right}
        </div>
        {props.topBanner ? <div style={{ marginTop: 8 }}>{props.topBanner}</div> : null}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>{props.children}</div>
      </div>
    </div>
  );
}



