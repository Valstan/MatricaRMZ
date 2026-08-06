import React from 'react';

export function EntityCardShell(props: {
  title: string;
  actions?: React.ReactNode;
  cardActions?: React.ReactNode;
  status?: React.ReactNode;
  children: React.ReactNode;
  layout?: 'stack' | 'two-column';
  className?: string;
  /** Комфортная ширина контента: контент центрируется, не растягиваясь на весь экран
      (глаза не бегают от левого края к правому на широких мониторах). */
  contentMaxWidth?: number;
}) {
  const layout = props.layout ?? 'stack';
  const showHeader = props.title && String(props.title).trim().length > 0;
  return (
    <div className={`entity-card-shell${props.className ? ` ${props.className}` : ''}`} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, width: '100%', minWidth: 0 }}>
      {props.cardActions && (
        <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
          {props.cardActions}
        </div>
      )}
      {showHeader && (
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
          {/* Заголовок — отдельным узлом: планшетный режим прячет ТОЛЬКО его. В этой же
              строке живут actions и status (в т.ч. «Ошибка: …» при сохранении) — их
              скрывать нельзя, иначе оператор не увидит, что правки не сохранились. */}
          <div className="mx-card-title" style={{ margin: 0, flex: '1 1 320px', minWidth: 0, fontSize: 'var(--ui-title-size)', fontWeight: 800 }}>{props.title}</div>
          {props.actions}
          {props.status}
        </div>
      )}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <div
          className={layout === 'two-column' ? 'entity-card-grid' : undefined}
          style={props.contentMaxWidth ? { maxWidth: props.contentMaxWidth, width: '100%', margin: '0 auto' } : undefined}
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
