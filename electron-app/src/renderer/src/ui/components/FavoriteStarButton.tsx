import React from 'react';

// Золотая звёздочка избранного (разделы + отчёты одним видом):
// пустой контур — не в избранном, залитая — в избранном.
export const FAVORITE_STAR_GOLD = '#c9930a';

export function FavoriteStarButton(props: {
  favorite: boolean;
  title: string;
  onToggle: () => void;
  size?: number;
  dataId?: string;
  /**
   * 'plain' — без рамки (звезда на вкладке в шапке): только сам значок, пустая ☆
   * или золотая ★. Владелец 13.11.2026: «звездочку сделай на пустом месте без
   * обрамления». 'framed' (по умолчанию) — кнопка в рамке: так выглядит звезда в МЕНЮ.
   */
  variant?: 'framed' | 'plain';
}) {
  const size = props.size ?? 30;
  const plain = props.variant === 'plain';
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
      title={props.title}
      aria-label={props.title}
      data-fav-star={props.dataId ?? '1'}
      data-fav-active={props.favorite ? '1' : undefined}
      data-fav-variant={plain ? 'plain' : undefined}
      style={
        plain
          ? {
              border: 'none',
              background: 'none',
              width: 'auto',
              minWidth: 0,
              height: 'auto',
              padding: '1px 3px',
              color: props.favorite ? FAVORITE_STAR_GOLD : 'var(--muted, #6b7280)',
              cursor: 'pointer',
              fontSize: Math.round(size * 0.92),
              lineHeight: 1,
            }
          : {
              border: '1px solid var(--border)',
              borderRadius: 8,
              width: size,
              minWidth: size,
              height: size,
              background: props.favorite ? 'rgba(201, 147, 10, 0.14)' : 'transparent',
              color: props.favorite ? FAVORITE_STAR_GOLD : 'var(--muted)',
              cursor: 'pointer',
              fontSize: Math.round(size * 0.6),
              lineHeight: 1,
              padding: 0,
            }
      }
    >
      {props.favorite ? '★' : '☆'}
    </button>
  );
}
