import React from 'react';

type ButtonTone = 'success' | 'info' | 'warn' | 'danger' | 'neutral';

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'outline'; tone?: ButtonTone; size?: 'sm' | 'md' | 'lg' }
>(function Button(props, ref) {
  const variant = props.variant === 'outline' ? 'ghost' : (props.variant ?? 'primary');
  const disabled = props.disabled === true;
  const tone = props.tone;
  const size = props.size ?? 'md';
  const sizeStyle: React.CSSProperties =
    size === 'sm'
      ? { padding: 'var(--ui-button-sm-padding, 4px 8px)', minHeight: 'var(--ui-button-sm-height, 26px)', fontSize: 'var(--ui-button-sm-font-size, 12px)' }
      : size === 'lg'
        ? { padding: 'var(--ui-button-lg-padding, 8px 12px)', minHeight: 'var(--ui-button-lg-height, 34px)', fontSize: 'var(--ui-button-lg-font-size, 14px)' }
        : { padding: 'var(--ui-button-md-padding, 5px 9px)', minHeight: 'var(--ui-button-md-height, 28px)', fontSize: 'var(--ui-button-md-font-size, 13px)' };
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
          ...sizeStyle,
          border: '1px solid var(--button-primary-border)',
          background: 'var(--button-primary-bg)',
          color: 'var(--button-primary-text)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontWeight: 700,
          lineHeight: 1.2,
          boxShadow: disabled ? 'none' : 'var(--button-primary-shadow)',
          opacity: disabled ? 0.55 : 1,
        }
      : {
          ...sizeStyle,
          border: '1px solid var(--button-ghost-border)',
          background: 'var(--button-ghost-bg)',
          color: 'var(--button-ghost-text)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontWeight: 650,
          lineHeight: 1.2,
          boxShadow: disabled ? 'none' : 'var(--button-ghost-shadow)',
          opacity: disabled ? 0.55 : 1,
        };

  return <button {...props} ref={ref} style={{ ...style, ...(toneStyle ?? {}), ...(props.style ?? {}) }} />;
});


