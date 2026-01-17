import React from 'react';

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {
  const variant = props.variant ?? 'primary';
  const base: React.CSSProperties = {
    borderRadius: 10,
    padding: '8px 12px',
    border: '1px solid transparent',
    fontWeight: 700,
    cursor: props.disabled ? 'not-allowed' : 'pointer',
    background: variant === 'primary' ? '#111827' : 'transparent',
    color: variant === 'primary' ? '#fff' : '#111827',
    opacity: props.disabled ? 0.6 : 1,
  };
  const ghost: React.CSSProperties =
    variant === 'ghost'
      ? { border: '1px solid #e5e7eb', background: '#fff', color: '#111827' }
      : {};

  return (
    <button {...props} style={{ ...base, ...ghost, ...(props.style ?? {}) }}>
      {props.children}
    </button>
  );
}
