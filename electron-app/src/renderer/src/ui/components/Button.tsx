import React from 'react';

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {
  const variant = props.variant ?? 'primary';
  const disabled = props.disabled === true;
  const style: React.CSSProperties =
    variant === 'primary'
      ? {
          padding: '7px 12px',
          border: '1px solid #1e40af',
          background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 60%, #7c3aed 120%)',
          color: '#fff',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontWeight: 700,
          fontSize: 14,
          lineHeight: 1.2,
          minHeight: 32,
          boxShadow: disabled ? 'none' : '0 6px 14px rgba(29, 78, 216, 0.18)',
          opacity: disabled ? 0.55 : 1,
        }
      : {
          padding: '7px 12px',
          border: '1px solid rgba(15, 23, 42, 0.25)',
          background: 'rgba(255,255,255,0.90)',
          color: '#0b1220',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontWeight: 650,
          fontSize: 14,
          lineHeight: 1.2,
          minHeight: 32,
          boxShadow: disabled ? 'none' : '0 6px 12px rgba(15, 23, 42, 0.07)',
          opacity: disabled ? 0.55 : 1,
        };

  return <button {...props} style={{ ...style, ...(props.style ?? {}) }} />;
}


