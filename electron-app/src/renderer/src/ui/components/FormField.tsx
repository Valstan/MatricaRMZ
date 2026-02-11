import React from 'react';

export function FormField(props: {
  label: string;
  children: React.ReactNode;
  fullWidth?: boolean;
  compact?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ minWidth: 0, gridColumn: props.fullWidth ? '1 / -1' : undefined, ...props.style }}>
      <label style={{ fontSize: 12, color: 'var(--muted)' }}>{props.label}</label>
      <div style={{ marginTop: props.compact ? 4 : 6 }}>{props.children}</div>
    </div>
  );
}
