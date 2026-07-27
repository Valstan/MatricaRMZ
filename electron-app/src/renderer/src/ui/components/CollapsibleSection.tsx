import React, { useState } from 'react';

/**
 * Сворачиваемая секция для длинных списков в карточках: по умолчанию свёрнута,
 * пользователь разворачивает сам (этап 4 плана tabs-window-shell-2026-07).
 * Контент при сворачивании размонтируется — для тяжёлых списков это и есть цель
 * (не грузить/не рендерить, пока не попросили). Если нужен keep-alive — держите
 * состояние выше по дереву.
 */
export function CollapsibleSection(props: {
  title: React.ReactNode;
  /** Бейдж количества в заголовке (обычно длина списка). */
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen === true);
  return (
    <div style={{ border: '1px solid var(--border, #e5e7eb)', borderRadius: 10, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '6px 10px',
          background: 'var(--surface-2, #f8fafc)',
          border: 'none',
          cursor: 'pointer',
          font: 'inherit',
          fontWeight: 700,
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 11, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>▶</span>
        <span style={{ flex: '1 1 auto', minWidth: 0 }}>{props.title}</span>
        {typeof props.count === 'number' && (
          <span
            style={{
              flex: '0 0 auto',
              padding: '1px 8px',
              borderRadius: 999,
              fontSize: 12,
              background: 'var(--card-panel-bg, #eff6ff)',
              color: 'var(--muted, #64748b)',
            }}
          >
            {props.count}
          </span>
        )}
      </button>
      {open && <div style={{ padding: '6px 8px' }}>{props.children}</div>}
    </div>
  );
}
