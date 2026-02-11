import React from 'react';

import { Input } from './Input.js';

export function NumericField(props: {
  value: number | string;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  width?: number;
}) {
  return (
    <Input
      type="number"
      min={props.min}
      max={props.max}
      disabled={props.disabled}
      value={props.value}
      onChange={(e) => props.onChange(Number(e.target.value) || 0)}
      style={{ width: props.width ?? 100, textAlign: 'right' }}
    />
  );
}
