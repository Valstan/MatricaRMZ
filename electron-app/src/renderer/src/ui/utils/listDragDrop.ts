/**
 * Порядок события `drop` и источник перетаскивания — чистая часть кита.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ (а не всё в `useListDrag`):
 * порядок, в котором браузер и React отдают `drop`, — это ровно тот класс, где
 * «всё зелёное, а строка не едет». Правило держится здесь, чисто и проверяемо,
 * а `useListDrag` — React-обвязка вокруг него.
 *
 * ПОРЯДОК СОБЫТИЙ (факт, а не догадка):
 *  1. capture-фаза: `window → document → … → корневой контейнер React → … → цель`;
 *  2. фаза цели;
 *  3. фаза всплытия: `цель → … → корневой контейнер React → … → document → window`.
 *
 * React 18 делегирует `onDrop` на корневой контейнер (`createRoot(root)`), и
 * синтетическое событие страницы срабатывает в фазе ВСПЛЫТИЯ на корне — то есть
 * ПОЗЖЕ capture-фазы на `document`. Значит, слушатель `drop` на `document`,
 * включённый с `capture = true`, гасит состояние перетаскивания ДО того, как
 * страница успела прочитать источник, — и перестановка не случается (владелец:
 * «перетаскивание строк в ПП не работает: строка остаётся на месте»).
 *
 * ОТСЮДА ДВА ПРАВИЛА:
 *  1. `drop` на `document` слушается в фазе ВСПЛЫТИЯ — после обработчика страницы;
 *  2. источник перетаскивания берётся из `dataTransfer` (браузер отдаёт его
 *     только в фазе drop), а не из внутреннего ref кита: ref мог быть погашен
 *     любым другим слушателем раньше, и подменять его «запасным вариантом»
 *     нельзя — источник должен пережить любое состояние рефа.
 */

/** Минимальный вид события перетаскивания, нужный киту. */
export type ListDragEventLike = {
  dataTransfer?: { getData?: (format: string) => string } | null;
};

/**
 * Ключ перетаскиваемой строки.
 *
 * Порядок источников:
 *  1. `dataTransfer` — то, что кит положил при старте перетаскивания. Это
 *     источник истины: браузер отдаёт `dataTransfer` только в фазе drop, и
 *     значение не зависит от того, погасил кто-нибудь ref кита или нет.
 *  2. ref кита — запасной вариант (например, если `dataTransfer` недоступен).
 */
export function listDragSourceKey(
  event: ListDragEventLike | null | undefined,
  fallbackKey?: string | null,
): string {
  const raw = event?.dataTransfer?.getData?.('text/plain');
  const fromTransfer = String(raw ?? '').trim();
  if (fromTransfer) return fromTransfer;
  return String(fallbackKey ?? '').trim();
}

/** Решение по drop: переставлять или не переставлять. */
export type ListDragDropTarget = {
  /** Индекс вставки в упорядоченном массиве строк. */
  index: number;
  /** Ключ строки-цели. */
  key: string;
  /** Линия рисуется ПЕРЕД строкой (`before`) или ПОСЛЕ неё (`after`). */
  position: 'before' | 'after';
};

export type ListDragDropDecision =
  | { kind: 'reorder'; sourceKey: string; target: ListDragDropTarget }
  | { kind: 'ignore'; reason: 'no-source' | 'no-target' };

/**
 * Что делать с drop'ом — одно решение на весь кит.
 *
 * Проверка источника идёт ПЕРВОЙ и по `dataTransfer`: реф кита к этому моменту
 * мог быть погашен слушателем, который отработал раньше (capture-фаза на
 * `document`), и тогда проверка «есть ли ref» отменяла бы перестановку при
 * живом источнике. Именно это и ломало перетаскивание в ПП и во всех списках
 * на ките.
 */
export function decideListDragDrop(params: {
  /** Ключ перетаскиваемой строки (из `dataTransfer`). */
  sourceKey: string | null | undefined;
  /** Место вставки, посчитанное китом по координатам и границе списка. */
  target: { index: number; key: string | null; position: 'before' | 'after' } | null;
}): ListDragDropDecision {
  const sourceKey = String(params.sourceKey ?? '').trim();
  if (!sourceKey) return { kind: 'ignore', reason: 'no-source' };
  const targetKey = String(params.target?.key ?? '').trim();
  if (!targetKey) return { kind: 'ignore', reason: 'no-target' };
  return {
    kind: 'reorder',
    sourceKey,
    target: { index: params.target?.index ?? 0, key: targetKey, position: params.target?.position ?? 'before' },
  };
}
