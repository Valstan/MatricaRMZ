import React, { useEffect, useState } from 'react';

import { Button } from './Button.js';

// Экранный числовой numpad для планшетного режима (Ф-later). Ввод количества пальцем без
// физической/системной клавиатуры: степперы +/- хороши для ±1, но набрать «12» ими — 12 тапов.
// Крупные клавиши (≥64px), клампится по max так же, как обычный инпут количества.
export function NumpadOverlay(props: {
  open: boolean;
  title?: string;
  initialValue: number | string;
  max?: number;
  onConfirm: (value: number) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<string>('');

  useEffect(() => {
    if (!props.open) return;
    const init = props.initialValue == null ? '' : String(props.initialValue);
    // 0 показываем как пустую строку — первый тап цифры сразу заменяет, а не даёт «05».
    setDraft(init === '0' ? '' : init);
  }, [props.open, props.initialValue]);

  if (!props.open) return null;

  const clamp = (n: number): number => {
    let v = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    if (typeof props.max === 'number' && Number.isFinite(props.max)) v = Math.min(v, props.max);
    return v;
  };

  const shown = draft === '' ? '0' : draft;
  const overMax = typeof props.max === 'number' && Number(shown) > props.max;

  const pressDigit = (d: string) => {
    setDraft((prev) => {
      const next = (prev + d).replace(/^0+(?=\d)/, '');
      return next.length > 6 ? prev : next; // разумный предел количества (до 999999)
    });
  };
  const backspace = () => setDraft((prev) => prev.slice(0, -1));
  const clearAll = () => setDraft('');
  const confirm = () => {
    props.onConfirm(clamp(Number(draft === '' ? '0' : draft)));
    props.onClose();
  };

  const keyBtnStyle: React.CSSProperties = {
    minHeight: 64,
    fontSize: 26,
    fontWeight: 600,
    borderRadius: 10,
    border: '1px solid var(--input-border)',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    cursor: 'pointer',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={props.onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)',
          padding: 18,
          borderRadius: 12,
          width: 'min(94vw, 360px)',
          border: '1px solid var(--border)',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
        }}
      >
        {props.title && (
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>{props.title}</div>
        )}
        <div
          aria-live="polite"
          style={{
            textAlign: 'right',
            fontSize: 34,
            fontWeight: 700,
            padding: '10px 14px',
            borderRadius: 10,
            border: '1px solid var(--input-border)',
            background: 'var(--input-bg)',
            color: overMax ? 'var(--danger)' : 'var(--text)',
            marginBottom: 6,
            minHeight: 56,
          }}
        >
          {shown}
        </div>
        {typeof props.max === 'number' && (
          <div style={{ fontSize: 12, color: overMax ? 'var(--danger)' : 'var(--subtle)', marginBottom: 10, textAlign: 'right' }}>
            {overMax ? `Максимум ${props.max} — будет ограничено` : `Максимум: ${props.max}`}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((d) => (
            <button key={d} type="button" style={keyBtnStyle} onClick={() => pressDigit(d)}>
              {d}
            </button>
          ))}
          <button type="button" style={keyBtnStyle} onClick={clearAll} aria-label="Очистить">
            C
          </button>
          <button type="button" style={keyBtnStyle} onClick={() => pressDigit('0')}>
            0
          </button>
          <button type="button" style={keyBtnStyle} onClick={backspace} aria-label="Удалить символ">
            ⌫
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Button variant="ghost" onClick={props.onClose} style={{ flex: 1, minHeight: 52, fontSize: 16 }}>
            Отмена
          </Button>
          <Button variant="primary" onClick={confirm} style={{ flex: 1, minHeight: 52, fontSize: 16 }}>
            Готово
          </Button>
        </div>
      </div>
    </div>
  );
}
