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
 * Список с ГРУППАМИ (ПП: договор → его двигатели).
 *
 * Кит перемещения по умолчанию работает с плоским списком: строка едет на позицию
 * вверх-вниз по всему списку. В ПП порядок **групповой**: двигатель едет внутри
 * своего договора, а договор — со своим блоком. Описание групп позволяет киту
 * считать движение в тех же границах, что и мышь: одна механика на программу,
 * а не две (одна для плоских списков, вторая для ПП).
 *
 * Ключ группы в ките — **тот же**, что у ручки заголовка группы; ключ строки —
 * её собственный. Плоский порядок списка (то, что кит получает в `orderedIds`)
 * в групповом списке — это блоки групп подряд: заголовок, затем его строки.
 */
export type ListMoveGrouping = {
  /** Ключи групп в текущем порядке. */
  groupKeys: string[];
  /** Ключи строк группы по ключу группы (в текущем порядке). */
  rowKeysOf: (groupKey: string) => string[];
  /** Ключ группы по ключу строки (null — строка вне групп). */
  groupOfRow: (rowKey: string) => string | null;
  /** Ключ — заголовок группы? */
  isGroupHeader: (key: string) => boolean;
};

/**
 * Клик по ручке в списке с группами.
 *
 * Отличие от плоского списка одно и важное: **ручка заголовка группы выбирает
 * всю группу** (её блок едет целиком), а ручка строки — саму строку (она едет
 * внутри своей группы). Множественный выбор (Ctrl/Shift) не пересекает границу
 * группы: блок из строк разных договоров не едет никуда — иначе двигатель
 * молча уехал бы в чужой договор, а это в ПП запрещено.
 */
export function applyGroupedHandleClick(
  current: ListMoveBlock,
  key: string,
  orderedIds: string[],
  grouping: ListMoveGrouping,
  mode: HandleClickMode,
): ListMoveBlock {
  const isHeader = grouping.isGroupHeader(key);
  const groupKey = isHeader ? key : grouping.groupOfRow(key);
  // Строка вне групп — ведём себя как в плоском списке.
  if (!groupKey) return applyHandleClick(current, key, orderedIds, mode);

  if (isHeader) {
    // Заголовок = вся группа: блок едет целиком.
    const unit = [key, ...grouping.rowKeysOf(key)];
    if (mode === 'replace') {
      const same = current.keys.length === unit.length && unit.every((k) => current.keys.includes(k));
      return same ? { keys: [] } : { keys: unit };
    }
    if (mode === 'add') {
      const exists = current.keys.includes(key);
      const keys = exists ? current.keys.filter((k) => !unit.includes(k)) : [...current.keys, ...unit];
      return { keys: orderedIds.filter((id) => keys.includes(id)) };
    }
    // Shift по заголовку — вся группа.
    return { keys: unit };
  }

  const groupRows = grouping.rowKeysOf(groupKey);
  if (mode === 'add') {
    const exists = current.keys.includes(key);
    const keys = exists ? current.keys.filter((k) => k !== key) : [...current.keys, key];
    // Блок не пересекает границу группы: чужая строка в блоке означает «сброс».
    const sameGroup = keys.every((k) => grouping.groupOfRow(k) === groupKey);
    return { keys: sameGroup ? groupRows.filter((k) => keys.includes(k)) : [key] };
  }
  if (mode === 'range') {
    const anchor = current.keys[current.keys.length - 1] ?? key;
    if (grouping.groupOfRow(anchor) !== groupKey) return { keys: [key] };
    const from = groupRows.indexOf(anchor);
    const to = groupRows.indexOf(key);
    if (from < 0 || to < 0) return { keys: [key] };
    const [start, end] = from <= to ? [from, to] : [to, from];
    return { keys: groupRows.slice(start, end + 1) };
  }
  // Обычный клик: та же строка — снимаем режим, другая — блок становится этой строкой.
  if (current.keys.length === 1 && current.keys[0] === key) return { keys: [] };
  return { keys: [key] };
}

/**
 * Куда сдвигается блок в списке с группами.
 *
 * Два случая, и они разные по существу:
 *  - в блоке **заголовок группы** ⇒ едет вся группа (заголовок + строки) среди
 *    других групп;
 *  - в блоке **только строки** ⇒ едут внутри своей группы; пересечь границу
 *    договора они не могут (в ПП двигатель свой договор не покидает).
 *
 * Возвращает НОВЫЙ плоский порядок списка — тем же языком, что и плоский режим.
 */
export function computeGroupedBlockMove(
  orderedIds: string[],
  grouping: ListMoveGrouping,
  keys: string[],
  direction: -1 | 1,
): { order: string[]; moved: boolean } {
  const block = keys.filter((k) => orderedIds.includes(k));
  if (!block.length) return { order: [...orderedIds], moved: false };

  const headerKey = block.find((k) => grouping.isGroupHeader(k));
  if (headerKey !== undefined) {
    const movedGroups = computeBlockMove(grouping.groupKeys, [headerKey], direction);
    if (!movedGroups.moved) return { order: [...orderedIds], moved: false };
    return { order: flattenGroups(grouping, movedGroups.order), moved: true };
  }

  // Строки едут только внутри своей группы: блок через две группы не едет никуда.
  const groups = new Set(block.map((k) => grouping.groupOfRow(k)).filter((k): k is string => Boolean(k)));
  if (groups.size !== 1) return { order: [...orderedIds], moved: false };
  const groupKey = [...groups][0]!;
  const movedRows = computeBlockMove(grouping.rowKeysOf(groupKey), block, direction);
  if (!movedRows.moved) return { order: [...orderedIds], moved: false };
  return { order: replaceGroupRows(orderedIds, grouping, groupKey, movedRows.order), moved: true };
}

/** Плоский порядок по порядку групп: заголовок, затем его строки. */
function flattenGroups(grouping: ListMoveGrouping, groupKeys: readonly string[]): string[] {
  const out: string[] = [];
  for (const groupKey of groupKeys) {
    out.push(groupKey, ...grouping.rowKeysOf(groupKey));
  }
  return out;
}

/** Заменить строки группы на новый порядок — на месте группы. */
function replaceGroupRows(
  orderedIds: readonly string[],
  grouping: ListMoveGrouping,
  groupKey: string,
  newRowKeys: readonly string[],
): string[] {
  const groupRows = grouping.rowKeysOf(groupKey);
  const rest = orderedIds.filter((key) => !groupRows.includes(key));
  const at = rest.indexOf(groupKey);
  if (at < 0) return [...orderedIds];
  return [...rest.slice(0, at + 1), ...newRowKeys, ...rest.slice(at + 1)];
}

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
