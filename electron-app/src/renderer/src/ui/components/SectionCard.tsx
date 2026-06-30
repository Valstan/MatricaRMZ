import React from 'react';

export function SectionCard(props: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Делает секцию сворачиваемой: заголовок становится кнопкой-переключателем с шевроном. */
  collapsible?: boolean;
  /** Стартовое состояние сворачиваемой секции (по умолчанию развёрнута). */
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = React.useState(props.defaultCollapsed === true);
  const canCollapse = props.collapsible === true;
  const showHeader = Boolean(props.title || props.actions || canCollapse);
  return (
    <div
      className={`card-panel ui-section-card ui-content-block${props.className ? ` ${props.className}` : ''}`}
      style={{ minWidth: 0, ...props.style }}
    >
      {showHeader && (
        <div className="ui-section-header">
          {canCollapse ? (
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: 'transparent',
                border: 'none',
                padding: 0,
                margin: 0,
                cursor: 'pointer',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                minWidth: 0,
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 11, opacity: 0.7, width: 10 }}>{collapsed ? '▸' : '▾'}</span>
              {props.title ? <strong className="ui-section-title">{props.title}</strong> : null}
            </button>
          ) : props.title ? (
            <strong className="ui-section-title">{props.title}</strong>
          ) : (
            <span />
          )}
          <span style={{ flex: 1 }} />
          {props.actions}
        </div>
      )}
      {(!canCollapse || !collapsed) && props.children}
    </div>
  );
}

