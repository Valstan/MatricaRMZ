import React, { useState } from 'react';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '9px 12px',
        borderRadius: 12,
        border: focused ? '1px solid #2563eb' : '1px solid rgba(15, 23, 42, 0.25)',
        outline: 'none',
        background: props.disabled ? 'rgba(241,245,249,0.8)' : 'rgba(255,255,255,0.95)',
        color: '#0b1220',
        boxShadow: focused ? '0 0 0 4px rgba(37, 99, 235, 0.18)' : '0 10px 18px rgba(15, 23, 42, 0.06)',
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
}


