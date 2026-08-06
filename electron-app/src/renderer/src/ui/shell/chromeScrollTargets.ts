// Какой скролл считается «прокруткой данных» (и потому убирает хром), а какой — нет.
// Прокрутка внутри самой панели разделов, выдвижного слоя, дока действий или выпадашки
// не должна прятать хром: оператор в этот момент работает именно с хромом.
//
// Функция чистая: на вход цепочка классов от узла-источника к корню — так её видит
// vitest в окружении 'node', а провайдер лишь собирает цепочку из DOM.

/** Контейнеры данных: их прокрутка и есть «оператор смотрит данные». */
export const DATA_SCROLL_CLASSES: readonly string[] = [
  'v3-split-list',
  'v3-card-body',
  'mx-data-scroll',
];

/** Хром и его начинка: прокрутка здесь ничего не прячет. */
export const CHROME_SCROLL_CLASSES: readonly string[] = [
  'v2-button-panel',
  'v3-tab-strip',
  'mx-drawer',
  'mx-chrome-rail',
  'card-action-bar',
];

/**
 * Цепочка идёт от источника события наружу: побеждает первое совпадение — вложенная
 * выпадашка внутри карточки должна остаться «хромом», хотя её предок — контейнер данных.
 * Неизвестный контейнер трактуем как НЕ данные: консервативно, хром остаётся на месте.
 */
export function isDataScrollTarget(chain: ReadonlyArray<ReadonlyArray<string>>): boolean {
  for (const classes of chain) {
    for (const cls of classes) {
      if (CHROME_SCROLL_CLASSES.includes(cls)) return false;
      if (DATA_SCROLL_CLASSES.includes(cls)) return true;
    }
  }
  return false;
}
