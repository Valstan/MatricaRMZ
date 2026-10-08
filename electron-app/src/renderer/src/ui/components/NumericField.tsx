import React, { useState } from 'react';

import { Input } from './Input.js';

export function NumericField(props: {
  value: number | string;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  width?: number;
}) {
  // Черновик живёт в поле, а не в карточке (09.10.2026): раньше каждый keystroke
  // поднимал setState родителя с перерендером всей карточки, а промежуточные
  // `""`/`"0."` схлопывались в `0` — цифры «прыгали». Коммит — на blur;
  // мусор/пустота откатываются к значению пропсов, а не к нулю.
  const [draft, setDraft] = useState<string | null>(null);
  const widthStyle = typeof props.width === 'number' ? `min(100%, ${props.width}px)` : '100%';
  return (
    <Input
      type="number"
      min={props.min}
      max={props.max}
      disabled={props.disabled}
      value={draft ?? String(props.value ?? '')}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft((d) => (d ?? String(props.value ?? '')))}
      onBlur={() => {
        const raw = (draft ?? '').trim().replace(',', '.');
        setDraft(null);
        if (!raw) return;
        const n = Number(raw);
        if (Number.isFinite(n)) props.onChange(n);
      }}
      style={{ width: widthStyle, textAlign: 'right' }}
    />
  );
}
