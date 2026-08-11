import React from 'react';

/**
 * Полоса вкладок карточки. Только шапка: панели рендерит вызывающий и держит их
 * СМОНТИРОВАННЫМИ (скрытие через hidden) — сохранение при закрытии, черновики и печать
 * читают state, и размонтирование скрытой вкладки их бы обнулило.
 */
export type CardTab<T extends string> = {
  key: T;
  label: string;
  /** Точка-индикатор: есть несохранённое / требует внимания. */
  dot?: 'warning' | 'info';
};

export function CardTabs<T extends string>(props: {
  tabs: CardTab<T>[];
  active: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  return (
    <div
      className={props.className ?? 'entity-card-span-full'}
      style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}
    >
      {props.tabs.map((t) => {
        const active = props.active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => props.onChange(t.key)}
            style={{
              padding: '7px 14px',
              borderRadius: '10px 10px 0 0',
              border: '1px solid var(--border)',
              borderBottom: 'none',
              background: active ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
              fontWeight: active ? 700 : 400,
              cursor: 'pointer',
              color: 'inherit',
              fontSize: 13,
            }}
          >
            {t.label}
            {t.dot ? <span style={{ color: t.dot === 'warning' ? 'var(--danger)' : '#2563eb' }}> ●</span> : null}
          </button>
        );
      })}
    </div>
  );
}
