import React, { useEffect, useRef } from 'react';

import { emojiAttrs } from '../utils/labelEmoji.js';

/**
 * Полоса вкладок карточки. Только шапка: панели рендерит вызывающий и держит их
 * СМОНТИРОВАННЫМИ (скрытие через hidden) — сохранение при закрытии, черновики и печать
 * читают state, и размонтирование скрытой вкладки их бы обнулило.
 *
 * Владелец 01.11.2026: полоса закреплена (при прокрутке длинной карточки вкладки
 * остаются на виду), под ВЫБРАННОЙ вкладкой разделителя нет — она сливается с полем
 * работы, а её фон заметно темнее фона невыбранных вкладок, чтобы сразу было видно,
 * где мы сейчас.
 */
export type CardTab<T extends string> = {
  key: T;
  label: string;
  /** Точка-индикатор: есть несохранённое / требует внимания. */
  dot?: 'warning' | 'info';
};

/** Фон выбранной вкладки: заметно темче фона полосы, но всё ещё светлый под тёмный текст. */
const ACTIVE_TAB_BG = 'color-mix(in srgb, var(--accent, #2563eb) 20%, var(--surface, #fff))';

export function CardTabs<T extends string>(props: {
  tabs: CardTab<T>[];
  active: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Высота полосы вкладок — в CSS-переменную на общем родителе: под вкладками липнет
  // шапка таблицы деталей, и без этого она заезжала бы под сами вкладки.
  useEffect(() => {
    const el = stripRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      parent.style.setProperty('--card-tabs-h', `${h}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      parent.style.removeProperty('--card-tabs-h');
    };
  }, []);

  return (
    <div
      ref={stripRef}
      className={props.className ?? 'entity-card-span-full'}
      style={{
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
        borderBottom: '1px solid var(--border)',
        // Закреплённая полоса: содержимое карточки уходит под неё, вкладки остаются видны.
        // top — высота панели действий (она закреплена выше): без этого вкладки
        // заезжали бы под панель и пропадали бы с глаз.
        position: 'sticky',
        top: 'var(--card-action-bar-h, 0px)',
        zIndex: 5,
        background: 'var(--surface, #fff)',
      }}
    >
      {props.tabs.map((t) => {
        const active = props.active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => props.onChange(t.key)}
            {...emojiAttrs(t.label)}
            style={{
              padding: '7px 14px',
              borderRadius: '10px 10px 0 0',
              border: '1px solid var(--border)',
              borderBottom: 'none',
              background: active ? ACTIVE_TAB_BG : 'transparent',
              fontWeight: active ? 700 : 400,
              cursor: 'pointer',
              color: active ? 'var(--accent, #2563eb)' : 'inherit',
              fontSize: 13,
              // Выбранная вкладка перекрывает разделитель под собой: между ней и полем
              // работы не остаётся линии — она читается как продолжение того, что открыто.
              ...(active ? { position: 'relative', zIndex: 1, marginBottom: '-1px' } : {}),
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
