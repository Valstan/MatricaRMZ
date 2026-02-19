import React from 'react';

export function SectionCard(props: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`card-panel ui-section-card${props.className ? ` ${props.className}` : ''}`} style={props.style}>
      {(props.title || props.actions) && (
        <div className="ui-section-header">
          {props.title ? <strong className="ui-section-title">{props.title}</strong> : <span />}
          <span style={{ flex: 1 }} />
          {props.actions}
        </div>
      )}
      {props.children}
    </div>
  );
}

