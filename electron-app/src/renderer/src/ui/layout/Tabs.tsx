import React from 'react';

import { Button } from '../components/Button.js';
import { tabAccent, theme } from '../theme.js';

export type TabId =
  | 'engines'
  | 'engine'
  | 'requests'
  | 'request'
  | 'parts'
  | 'part'
  | 'changes'
  | 'auth'
  | 'reports'
  | 'masterdata'
  | 'admin'
  | 'audit'
  | 'settings';

export function Tabs(props: {
  tab: TabId;
  onTab: (t: Exclude<TabId, 'engine' | 'request' | 'part'>) => void;
  visibleTabs: Exclude<TabId, 'engine' | 'request' | 'part'>[];
  userLabel: string;
  userTab: Exclude<TabId, 'engine' | 'request' | 'part'>;
  authStatus?: { online: boolean | null };
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

  const authDot =
    props.authStatus?.online == null ? null : (
      <span
        className={props.authStatus.online ? 'chatBlink' : undefined}
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          display: 'inline-block',
          background: props.authStatus.online ? '#16a34a' : '#dc2626',
          boxShadow: '0 0 0 2px rgba(0,0,0,0.08)',
        }}
        title={props.authStatus.online ? 'В сети' : 'Не в сети'}
      />
    );

  return (
    <div style={{ display: 'flex', gap: 6, rowGap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
      {props.visibleTabs.includes('masterdata') && tabButton('masterdata', 'Справочники')}
      {props.visibleTabs.includes('changes') && tabButton('changes', 'Изменения')}
      {props.visibleTabs.includes('engines') && tabButton('engines', 'Двигатели')}
      {props.visibleTabs.includes('requests') && tabButton('requests', 'Заявки')}
      {props.visibleTabs.includes('parts') && tabButton('parts', 'Детали')}
      {props.visibleTabs.includes('reports') && tabButton('reports', 'Отчёты')}
      <span style={{ flex: 1 }} />
      {props.visibleTabs.includes('audit') && tabButton('audit', 'Журнал')}
      {props.visibleTabs.includes('admin') && tabButton('admin', 'Админ')}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {authDot}
        {tabButton(props.userTab, props.userLabel?.trim() ? props.userLabel.trim() : 'Вход')}
      </div>
      {props.right}
    </div>
  );
}


