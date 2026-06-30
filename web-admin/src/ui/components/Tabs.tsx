import React from 'react';

import { Button } from './Button.js';

export function Tabs(props: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  notesAlertCount?: number;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {props.tabs.map((t) => (
        <Button
          key={t.id}
          variant={props.active === t.id ? 'primary' : 'ghost'}
          onClick={() => props.onChange(t.id)}
          className={t.id === 'notes' && (props.notesAlertCount ?? 0) > 0 ? 'notes-tab-blink' : undefined}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t.label}
            {t.id === 'notes' && (props.notesAlertCount ?? 0) > 0 ? (
              <span style={{ color: '#b91c1c', fontWeight: 900 }}>{props.notesAlertCount}</span>
            ) : null}
          </span>
        </Button>
      ))}
    </div>
  );
}

