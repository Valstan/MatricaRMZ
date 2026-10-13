/**
 * Чистое позиционирование выпадашки подсказок (A2: вис при открытом дропдауне).
 *
 * Корень виса: эффект позиционирования в `useSuggestionDropdown` звал
 * `setPopupRect({...})` безусловно — свежим объектом каждый раз. Если вызывающий
 * строит `options` инлайном при рендере (как подписи актов и пикер этапов),
 * `filtered` пересчитывается каждый рендер → эффект перезапускается → новый
 * setState → новый рендер: бесконечный цикл с замером canvas на каждой итерации,
 * главный поток мёртв, окно не закрывается.
 *
 * Лечение двумя слоями: (1) эта чистая функция считает размещение
 * детерминированно (округление до px); (2) хук хранит последнее применённое
 * размещение в ref и зовёт setState, только если значения реально изменились —
 * цикл умирает на второй итерации, что бы ни присылал вызывающий.
 */

export type SuggestRect = { left: number; top: number; bottom: number; width: number };

export type SuggestPlacement =
  | { left: number; width: number; maxHeight: number; placement: 'below'; top: number }
  | { left: number; width: number; maxHeight: number; placement: 'above'; bottom: number };

export function computeSuggestPlacement(
  viewportW: number,
  viewportH: number,
  rect: SuggestRect,
  contentW: number,
): SuggestPlacement {
  const gap = 6;
  const padding = 8;
  const width = Math.min(Math.max(rect.width, contentW, 160), viewportW - padding * 2);

  let left = rect.left;
  if (left + width > viewportW - padding) left = viewportW - padding - width;
  if (left < padding) left = padding;

  const spaceBelow = Math.max(0, viewportH - rect.bottom - gap - padding);
  const spaceAbove = Math.max(0, rect.top - gap - padding);
  const preferTop = spaceBelow < 250 && spaceAbove > spaceBelow;

  const maxAvailable = preferTop ? spaceAbove : spaceBelow;
  const effectiveMaxHeight = Math.max(120, maxAvailable);

  if (preferTop) {
    return {
      left: Math.round(left),
      width: Math.round(width),
      maxHeight: Math.round(effectiveMaxHeight),
      placement: 'above',
      bottom: Math.round(viewportH - rect.top + gap),
    };
  }
  return {
    left: Math.round(left),
    width: Math.round(width),
    maxHeight: Math.round(effectiveMaxHeight),
    placement: 'below',
    top: Math.round(Math.max(rect.bottom + gap, padding)),
  };
}

/** Поколоночное сравнение: сошлось — setState не нужен, цикл останавливается. */
export function samePlacement(a: SuggestPlacement | null, b: SuggestPlacement | null): boolean {
  if (!a || !b) return false;
  if (a.left !== b.left || a.width !== b.width || a.maxHeight !== b.maxHeight || a.placement !== b.placement) return false;
  if (a.placement === 'below' && b.placement === 'below') return a.top === b.top;
  if (a.placement === 'above' && b.placement === 'above') return a.bottom === b.bottom;
  return false;
}
