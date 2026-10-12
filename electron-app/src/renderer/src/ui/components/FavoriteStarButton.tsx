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
}) {
  const size = props.size ?? 30;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
      title={props.title}
      aria-label={props.title}
      data-fav-star={props.dataId ?? '1'}
      data-fav-active={props.favorite ? '1' : undefined}
      style={{
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
      }}
    >
      {props.favorite ? '★' : '☆'}
    </button>
  );
}
