import React from 'react';

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {
  const variant = props.variant ?? 'primary';
  const disabled = props.disabled === true;
  const style: React.CSSProperties =
    variant === 'primary'
      ? {
          padding: '9px 14px',
          borderRadius: 12,
          border: '1px solid #1e40af',
          background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 60%, #7c3aed 120%)',
          color: '#fff',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontWeight: 700,
          boxShadow: disabled ? 'none' : '0 10px 22px rgba(29, 78, 216, 0.20)',
          opacity: disabled ? 0.55 : 1,
        }
      : {
          padding: '9px 14px',
          borderRadius: 12,
          border: '1px solid rgba(15, 23, 42, 0.25)',
          background: 'rgba(255,255,255,0.90)',
          color: '#0b1220',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontWeight: 650,
          boxShadow: disabled ? 'none' : '0 10px 18px rgba(15, 23, 42, 0.08)',
          opacity: disabled ? 0.55 : 1,
        };

  return <button {...props} style={{ ...style, ...(props.style ?? {}) }} />;
}


