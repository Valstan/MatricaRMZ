import React from 'react';

import { isAndroidPlatform } from '../platform.js';

export function ColumnToggleButton(props: {
  colId: string;
  visible: boolean;
  alwaysVisible?: boolean | undefined;
  onToggle: () => void;
}) {
  if (!isAndroidPlatform()) return null;
  if (props.alwaysVisible) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        props.onToggle();
      }}
      title={props.visible ? 'Скрыть колонку' : 'Показать колонку'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        padding: 0,
        margin: '0 0 0 2px',
        border: 'none',
        background: 'transparent',
        color: props.visible ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.85)',
        fontSize: 14,
        fontWeight: 700,
        lineHeight: 1,
        cursor: 'pointer',
        borderRadius: 3,
        flexShrink: 0,
      }}
    >
      {props.visible ? '×' : '+'}
    </button>
  );
}

export function HiddenColumnMarker(props: {
  colId: string;
  label: string;
  onShow: () => void;
}) {
  if (!isAndroidPlatform()) return <th aria-hidden="true" style={{ width: 4, padding: 0 }} />;
  return (
    <th style={{ width: 28, padding: 0, textAlign: 'center', verticalAlign: 'middle' }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          props.onShow();
        }}
        title={`Показать «${props.label}»`}
        style={{
          width: 22,
          height: 22,
          padding: 0,
          border: '1px dashed rgba(255,255,255,0.35)',
          borderRadius: 4,
          background: 'rgba(255,255,255,0.08)',
          color: 'rgba(255,255,255,0.7)',
          fontSize: 13,
          fontWeight: 700,
          lineHeight: 1,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        +
      </button>
    </th>
  );
}
