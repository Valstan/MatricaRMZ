import React from 'react';

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {
  const variant = props.variant ?? 'primary';
  const style: React.CSSProperties =
    variant === 'primary'
      ? {
          padding: '8px 12px',
          borderRadius: 10,
          border: '1px solid #0f172a',
          background: '#0f172a',
          color: '#fff',
          cursor: 'pointer',
        }
      : {
          padding: '8px 12px',
          borderRadius: 10,
          border: '1px solid #d1d5db',
          background: '#fff',
          color: '#111827',
          cursor: 'pointer',
        };

  return <button {...props} style={{ ...style, ...(props.style ?? {}) }} />;
}


