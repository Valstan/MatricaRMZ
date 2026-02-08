import React from 'react';

type ButtonTone = 'success' | 'info' | 'warn' | 'danger' | 'neutral';

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost'; tone?: ButtonTone },
) {
  const variant = props.variant ?? 'primary';
  const disabled = props.disabled === true;
  const tone = props.tone;
  const toneStyle: React.CSSProperties | null = tone
    ? {
        background: `var(--tone-${tone}-bg)`,
        border: `1px solid var(--tone-${tone}-border)`,
        color: `var(--tone-${tone}-text)`,
        boxShadow: disabled ? 'none' : 'var(--button-primary-shadow)',
      }
    : null;
  const style: React.CSSProperties =
    variant === 'primary'
      ? {
          padding: '7px 12px',
          border: '1px solid var(--button-primary-border)',
          background: 'var(--button-primary-bg)',
          color: 'var(--button-primary-text)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontWeight: 700,
          fontSize: 14,
          lineHeight: 1.2,
          minHeight: 32,
          boxShadow: disabled ? 'none' : 'var(--button-primary-shadow)',
          opacity: disabled ? 0.55 : 1,
        }
      : {
          padding: '7px 12px',
          border: '1px solid var(--button-ghost-border)',
          background: 'var(--button-ghost-bg)',
          color: 'var(--button-ghost-text)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontWeight: 650,
          fontSize: 14,
          lineHeight: 1.2,
          minHeight: 32,
          boxShadow: disabled ? 'none' : 'var(--button-ghost-shadow)',
          opacity: disabled ? 0.55 : 1,
        };

  return <button {...props} style={{ ...style, ...(toneStyle ?? {}), ...(props.style ?? {}) }} />;
}


