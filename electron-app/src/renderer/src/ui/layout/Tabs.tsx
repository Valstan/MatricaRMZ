import React from 'react';

import { Button } from '../components/Button.js';
import { tabAccent, theme } from '../theme.js';

export type TabId = 'engines' | 'engine' | 'requests' | 'request' | 'parts' | 'part' | 'auth' | 'sync' | 'reports' | 'admin' | 'audit';

export function Tabs(props: {
  tab: TabId;
  onTab: (t: Exclude<TabId, 'engine' | 'request'>) => void;
      visibleTabs: Exclude<TabId, 'engine' | 'request' | 'part'>[];
  right?: React.ReactNode;
}) {
  function tabButton(id: Exclude<TabId, 'engine' | 'request' | 'part'>, label: string) {
    const acc = theme.accents[tabAccent(id)];
    const active = props.tab === id;
    return (
      <Button
        key={id}
        variant="ghost"
        onClick={() => props.onTab(id)}
        style={
          active
            ? {
                border: `1px solid ${acc.border}`,
                background: `linear-gradient(135deg, ${acc.bg} 0%, ${acc.border} 120%)`,
                color: acc.text,
                boxShadow: '0 12px 22px rgba(0,0,0,0.15)',
              }
            : {
                border: `1px solid ${acc.border}`,
                background: theme.colors.surface2,
                color: acc.border,
                boxShadow: '0 10px 18px rgba(15, 23, 42, 0.08)',
              }
        }
      >
        {label}
      </Button>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
      {props.visibleTabs.includes('admin') && (
        tabButton('admin', 'Справочники')
      )}
      {props.visibleTabs.includes('engines') && tabButton('engines', 'Двигатели')}
      {props.visibleTabs.includes('requests') && tabButton('requests', 'Заявки')}
      {props.visibleTabs.includes('parts') && tabButton('parts', 'Детали')}
      {props.visibleTabs.includes('reports') && tabButton('reports', 'Отчёты')}
      <span style={{ flex: 1 }} />
      {props.visibleTabs.includes('audit') && tabButton('audit', 'Журнал')}
      {props.visibleTabs.includes('sync') && tabButton('sync', 'Синхронизация')}
      {tabButton('auth', 'Вход')}
      {props.right}
    </div>
  );
}


