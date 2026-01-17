import React from 'react';

import { Button } from './Button.js';

export function Tabs(props: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {props.tabs.map((t) => (
        <Button key={t.id} variant={props.active === t.id ? 'primary' : 'ghost'} onClick={() => props.onChange(t.id)}>
          {t.label}
        </Button>
      ))}
    </div>
  );
}

