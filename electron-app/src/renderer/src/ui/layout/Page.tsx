import React from 'react';
import { theme } from '../theme.js';

export function Page(props: {
  topBanner?: React.ReactNode;
  children: React.ReactNode;
  uiTheme?: 'light' | 'dark' | 'warm';
}) {
  const gradient =
    props.uiTheme === 'light'
      ? `linear-gradient(135deg, #e2e8f0 0%, #f8fafc 45%, #e0f2fe 100%)`
      : props.uiTheme === 'warm'
        ? `linear-gradient(135deg, #efe1c6 0%, #faf1dd 45%, #f3e3c3 100%)`
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
        {props.topBanner ? <div style={{ marginTop: 8 }}>{props.topBanner}</div> : null}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>{props.children}</div>
      </div>
    </div>
  );
}
