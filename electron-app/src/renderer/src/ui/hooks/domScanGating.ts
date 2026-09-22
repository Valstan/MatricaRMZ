/**
 * Чистая часть двух глобальных сканеров DOM (`useAdaptiveListTables`, `useAutoGrowInputs`):
 * решение «пересчитывать ли по этой пачке мутаций», отсрочка на время прокрутки и
 * арифметика автоширины поля.
 *
 * Вынесено отдельным модулем, потому что решение принимается на КАЖДУЮ пачку мутаций
 * документа (набор текста в чате — это поток пачек на каждую букву), а цена ошибки —
 * обход всех строк всех видимых таблиц. Такое место должно проверяться тестом, а тесты
 * здесь идут в окружении `node`, без DOM: поэтому функции duck-typed и не знают об
 * Element/MutationRecord, им достаточно `matches`/`querySelector`/`closest`.
 */

export const LIST_TABLE_SELECTOR = 'table.list-table';
export const INPUT_SELECTOR = 'input';
export const PANE_ACTIVE_ATTR = 'data-pane-active';

/** Trailing-задержка коалесинга пересчёта таблиц (мс). */
export const RECALC_DELAY_MS = 150;
/** Пока с последней прокрутки прошло меньше — пересчёт откладываем (мс). */
export const SCROLL_QUIET_MS = 200;

type SelectorNode = {
  matches?: (selector: string) => boolean;
  querySelector?: (selector: string) => unknown;
  closest?: (selector: string) => unknown;
  parentElement?: SelectorNode | null;
};

/** Мутация в объёме, который нужен для решения: тип, имя атрибута, цель, добавленные узлы. */
export type ScanMutationLike = {
  type: string;
  attributeName?: string | null;
  target?: SelectorNode | null;
  addedNodes?: ArrayLike<SelectorNode | null | undefined>;
};

function matchesUpwards(node: SelectorNode | null | undefined, selector: string): boolean {
  let current: SelectorNode | null | undefined = node;
  // characterData-мутация приходит на текстовый узел: у него нет closest, поднимаемся к элементу.
  for (let hops = 0; current && hops < 4; hops += 1) {
    if (typeof current.closest === 'function') return current.closest(selector) != null;
    current = current.parentElement ?? null;
  }
  return false;
}

function subtreeHas(node: SelectorNode | null | undefined, selector: string): boolean {
  if (!node) return false;
  if (typeof node.matches === 'function' && node.matches(selector)) return true;
  return typeof node.querySelector === 'function' && node.querySelector(selector) != null;
}

/** Цель мутации лежит внутри таблицы списка (или сама ею является). */
export function isInsideListTable(node: SelectorNode | null | undefined): boolean {
  return matchesUpwards(node, LIST_TABLE_SELECTOR);
}

export function mutationRequestsListRecalc(mutation: ScanMutationLike): boolean {
  // Смена активной вкладки — единственный атрибут, который нас касается: сам показ панели
  // не меняет ни childList, ни characterData, и без этого сигнала пересчёт не запустился бы.
  if (mutation.type === 'attributes') return mutation.attributeName === PANE_ACTIVE_ATTR;
  if (isInsideListTable(mutation.target)) return true;
  if (mutation.type !== 'childList') return false;
  const added = mutation.addedNodes;
  if (!added) return false;
  // Впервые отрисованная таблица приходит добавленным узлом, её target — контейнер снаружи.
  for (let i = 0; i < added.length; i += 1) {
    if (subtreeHas(added[i], LIST_TABLE_SELECTOR)) return true;
  }
  return false;
}

export function shouldRecalcListTables(mutations: ArrayLike<ScanMutationLike>): boolean {
  for (let i = 0; i < mutations.length; i += 1) {
    const mutation = mutations[i];
    if (mutation && mutationRequestsListRecalc(mutation)) return true;
  }
  return false;
}

export function mutationRequestsAutoGrowSync(mutation: ScanMutationLike): boolean {
  // Наблюдатель слушает ровно четыре атрибута (type/placeholder/data-autogrow/pane) —
  // любой из них повод пройтись; фильтровать есть смысл только поток childList.
  if (mutation.type !== 'childList') return true;
  const added = mutation.addedNodes;
  if (!added) return false;
  for (let i = 0; i < added.length; i += 1) {
    if (subtreeHas(added[i], INPUT_SELECTOR)) return true;
  }
  return false;
}

export function shouldSyncAutoGrowInputs(mutations: ArrayLike<ScanMutationLike>): boolean {
  for (let i = 0; i < mutations.length; i += 1) {
    const mutation = mutations[i];
    if (mutation && mutationRequestsAutoGrowSync(mutation)) return true;
  }
  return false;
}

/**
 * Прокрутка виртуального списка — это непрерывный поток мутаций строк: пересчитывать
 * посреди неё и дорого, и бесполезно (через кадр строки снова другие).
 */
export function shouldDeferScan(lastScrollAt: number, now: number, quietMs: number = SCROLL_QUIET_MS): boolean {
  if (!Number.isFinite(lastScrollAt) || lastScrollAt <= 0) return false;
  return now - lastScrollAt < quietMs;
}

/** Лишняя запись в style/атрибут инвалидирует раскладку, даже когда значение то же. */
export function shouldWriteValue(current: string | null | undefined, next: string): boolean {
  return (current ?? '') !== next;
}

export type AutoGrowSize = {
  minChars: number;
  maxChars: number;
  extraChars: number;
};

/** Длина, по которой растёт поле: значение, а пока его нет — placeholder. */
export function autoGrowContentLength(value: string | null | undefined, placeholder: string | null | undefined): number {
  const text = String(value ?? '');
  const hint = String(placeholder ?? '');
  return Math.max(1, text.length > 0 ? text.length : hint.length);
}

export function computeAutoGrowChars(contentLength: number, size: AutoGrowSize): number {
  const min = Math.round(size.minChars);
  const max = Math.max(min, Math.round(size.maxChars));
  const raw = Math.round((Number.isFinite(contentLength) ? contentLength : 1) + size.extraChars);
  return Math.min(max, Math.max(min, raw));
}

export function autoGrowWidthCss(chars: number): string {
  return `${chars}ch`;
}
