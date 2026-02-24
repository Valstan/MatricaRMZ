import React from 'react';

export function EntityCardShell(props: {
  title: string;
  actions?: React.ReactNode;
  cardActions?: React.ReactNode;
  status?: React.ReactNode;
  children: React.ReactNode;
  layout?: 'stack' | 'two-column';
}) {
  const layout = props.layout ?? 'stack';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {props.cardActions && (
        <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
          {props.cardActions}
        </div>
      )}
      <div
        className="ui-section-header"
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          paddingBottom: 8,
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ margin: 0, flex: '1 1 320px', minWidth: 0, fontSize: 'var(--ui-title-size)', fontWeight: 800 }}>{props.title}</div>
        {props.actions}
        {props.status}
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <div className={layout === 'two-column' ? 'entity-card-grid' : undefined}>{props.children}</div>
      </div>
    </div>
  );
}
