/**
 * Клавиатурное перемещение по ручке (промт КАРМАНА #67): клик по ручке «⠿» — ручка
 * краснеет, строка обводится красной рамкой, стрелки ↑/↓ двигают строку на позицию,
 * повторный клик снимает. Через те же ручки выделяется несколько строк, и они
 * перемещаются блоком.
 *
 * Приоритет зафиксирован правилом проекта (`WorkSheetsPage.guard.test.ts`): перетаскивание
 * мышью — приоритет, стрелки — второй способ (в том числе на планшете, где мыши нет).
 * Здесь мышь и клавиатура работают вместе: ручка одна на оба способа.
 */

export type ListMoveBlock = {
  /** Ключи строк, входящих в перемещаемый блок, в порядке списка. */
  keys: string[];
};

export type HandleClickMode = 'replace' | 'add' | 'range';

/**
 * Что делает клик по ручке:
 *  - `replace` — блок = эта строка (обычный клик);
 *  - `add` — строка добавляется/убирается из блока (Ctrl+клик);
 *  - `range` — блок = диапазон от опорной строки до этой (Shift+клик).
 */
export function applyHandleClick(
  current: ListMoveBlock,
  key: string,
  orderedIds: string[],
  mode: HandleClickMode,
): ListMoveBlock {
  if (mode === 'add') {
    const exists = current.keys.includes(key);
    const keys = exists ? current.keys.filter((k) => k !== key) : [...current.keys, key];
    return { keys: orderedIds.filter((id) => keys.includes(id)) };
  }
  if (mode === 'range') {
    const anchor = current.keys[current.keys.length - 1] ?? key;
    const from = orderedIds.indexOf(anchor);
    const to = orderedIds.indexOf(key);
    if (from < 0 || to < 0) return { keys: [key] };
    const [start, end] = from <= to ? [from, to] : [to, from];
    return { keys: orderedIds.slice(start, end + 1) };
  }
  // Обычный клик: та же строка — снимаем режим (заказ владельца: «повторный щелчок
  // по этим шести точкам снимает выделение»), другая — блок становится этой строкой.
  if (current.keys.length === 1 && current.keys[0] === key) return { keys: [] };
  return { keys: [key] };
}

/**
 * Куда сдвигается блок на одну позицию. Возвращает НОВЫЙ порядок списка целиком:
 * сохранение — за списком (у каждого свой механизм порядка), а кит считает только
 * механику перемещения.
 */
export function computeBlockMove(
  orderedIds: string[],
  keys: string[],
  direction: -1 | 1,
): { order: string[]; moved: boolean } {
  const block = keys.filter((k) => orderedIds.includes(k));
  if (!block.length) return { order: [...orderedIds], moved: false };
  const indices = block.map((k) => orderedIds.indexOf(k)).filter((i) => i >= 0);
  if (!indices.length) return { order: [...orderedIds], moved: false };
  const first = Math.min(...indices);
  const last = Math.max(...indices);

  if (direction === -1) {
    if (first === 0) return { order: [...orderedIds], moved: false };
    const above = orderedIds[first - 1]!;
    // Блок вынимаем, строка над ним остаётся на месте — блок встаёт НА её место.
    const rest = orderedIds.filter((id) => !block.includes(id));
    const at = rest.indexOf(above);
    return { order: [...rest.slice(0, at), ...block, ...rest.slice(at)], moved: true };
  }

  if (last >= orderedIds.length - 1) return { order: [...orderedIds], moved: false };
  const below = orderedIds[last + 1]!;
  // Блок вынимаем, строка под ним остаётся на месте — блок встаёт ПОСЛЕ неё.
  const rest = orderedIds.filter((id) => !block.includes(id));
  const at = rest.indexOf(below) + 1;
  return { order: [...rest.slice(0, at), ...block, ...rest.slice(at)], moved: true };
}

/**
 * Активен только ОДИН список в программе.
 *
 * На странице списков несколько (карточка наряда: бригада, подписи, виды работ;
 * редактор шаблона наряда: блоки подписей), и ручка «⠿» есть у каждого. Без этого
 * правила клик по ручке второго списка НЕ снимал бы режим первого — и одно нажатие
 * стрелки двигало бы строки обоих списков сразу. Активная ручка — одна: значит, и
 * список, который двигают, один.
 */
const moveOwners = new Map<symbol, () => void>();
let activeOwner: symbol | null = null;

/** Зарегистрировать список в ките (при монтировании). Возвращает функцию снятия. */
export function registerMoveOwner(owner: symbol, clear: () => void): () => void {
  moveOwners.set(owner, clear);
  return () => {
    moveOwners.delete(owner);
    if (activeOwner === owner) activeOwner = null;
  };
}

/** Забрать режим перемещения себе: у прежнего владельца он снимается. */
export function claimMoveOwner(owner: symbol): void {
  for (const [other, clear] of moveOwners) {
    if (other === owner) continue;
    clear();
  }
  activeOwner = owner;
}

/** Отпустить режим перемещения — если он принадлежит этому владельцу. */
export function releaseMoveOwner(owner: symbol): void {
  if (activeOwner === owner) activeOwner = null;
}

/** Кто сейчас двигает строки (null — никто). */
export function currentMoveOwner(): symbol | null {
  return activeOwner;
}

/** Что сказать скринридеру (и что показать в подсказке) при перемещении. */
export function describeMoveResult(order: string[], block: string[], moved: boolean): string {
  if (!moved) return 'Строка не двигается — это край списка';
  const firstIndex = order.findIndex((id) => block.includes(id));
  const position = firstIndex >= 0 ? firstIndex + 1 : 0;
  return block.length > 1
    ? `Перемещено строк: ${block.length}, новая позиция: ${position}`
    : `Строка перемещена, новая позиция: ${position}`;
}
