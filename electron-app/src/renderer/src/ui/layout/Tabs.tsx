import React from 'react';

import { Button } from '../components/Button.js';

export type TabId = 'engines' | 'engine' | 'auth' | 'sync' | 'reports' | 'admin' | 'audit';

export function Tabs(props: {
  tab: TabId;
  onTab: (t: Exclude<TabId, 'engine'>) => void;
  right?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
      <Button variant={props.tab === 'engines' ? 'primary' : 'ghost'} onClick={() => props.onTab('engines')}>
        Двигатели
      </Button>
      <Button variant={props.tab === 'auth' ? 'primary' : 'ghost'} onClick={() => props.onTab('auth')}>
        Вход
      </Button>
      <Button variant={props.tab === 'sync' ? 'primary' : 'ghost'} onClick={() => props.onTab('sync')}>
        Синхронизация
      </Button>
      <Button variant={props.tab === 'reports' ? 'primary' : 'ghost'} onClick={() => props.onTab('reports')}>
        Отчёты
      </Button>
      <Button variant={props.tab === 'admin' ? 'primary' : 'ghost'} onClick={() => props.onTab('admin')}>
        Справочники
      </Button>
      <Button variant={props.tab === 'audit' ? 'primary' : 'ghost'} onClick={() => props.onTab('audit')}>
        Журнал
      </Button>
      <span style={{ flex: 1 }} />
      {props.right}
    </div>
  );
}


