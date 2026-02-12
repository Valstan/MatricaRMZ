import React, { useState } from 'react';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => {
  const [focused, setFocused] = useState(false);
  return (
    <input
      {...props}
      ref={ref}
      style={{
        width: '100%',
        padding: '4px 6px',
        border: focused ? '1px solid var(--input-border-focus)' : '1px solid var(--input-border)',
        outline: 'none',
        background: props.disabled ? 'var(--input-bg-disabled)' : 'var(--input-bg)',
        color: 'var(--text)',
        fontSize: 13,
        lineHeight: 1.2,
        minHeight: 28,
        boxShadow: focused ? 'var(--input-shadow-focus)' : 'var(--input-shadow)',
        ...(props.style ?? {}),
      }}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
});

Input.displayName = 'Input';


