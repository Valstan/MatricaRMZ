import React from 'react';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        padding: '8px 10px',
        borderRadius: 10,
        border: '1px solid #d1d5db',
        outline: 'none',
        ...(props.style ?? {}),
      }}
    />
  );
}
