import React from 'react';

import { ENGINE_SCRAP_BADGE_BACKGROUND, ENGINE_SCRAP_BADGE_COLOR, ENGINE_SCRAP_BADGE_LABEL } from '@matricarmz/shared';

/**
 * Плашка «Утиль» на карточке двигателя.
 *
 * ЗАЧЕМ. Утильный двигатель должен читаться СРАЗУ, а не вычисляться оператором: в шапке
 * карточки розовая плашка стоит рядом с номером, и видно сразу — это «прозрачный» двигатель,
 * который уже не в ремонте. Розовый фон строки в списках — то же самое, но в карточке
 * двигателя строки нет, поэтому плашка.
 *
 * Цвет — из общего правила `shared/src/domain/engineScrap.ts`: тот же плотный розовый,
 * что и для печати, и тот же тёмно-красный текст.
 */
export function EngineScrapBadge(props: { isScrap?: boolean | null }) {
  if (props.isScrap !== true) return null;
  return (
    <span
      data-engine-scrap-badge="true"
      title="Двигатель признан утильным"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 10px',
        borderRadius: 999,
        background: ENGINE_SCRAP_BADGE_BACKGROUND,
        color: ENGINE_SCRAP_BADGE_COLOR,
        border: `1px solid ${ENGINE_SCRAP_BADGE_COLOR}`,
        fontSize: 12,
        fontWeight: 800,
        letterSpacing: 0.2,
        whiteSpace: 'nowrap',
      }}
    >
      {ENGINE_SCRAP_BADGE_LABEL}
    </span>
  );
}
