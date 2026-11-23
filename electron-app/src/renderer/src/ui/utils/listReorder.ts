/**
 * Перестановка строк списка по новому порядку (промт КАРМАНА #67, фаза «карточки»).
 *
 * Кит перемещения говорит на языке ПОРЯДКА: «вот новый порядок строк». Список же хранит
 * МАССИВ строк и умеет сохранять его по-своему (перенумеровать `lineNo`, пересобрать
 * `payload`, отправить на сервер). Между этими двумя мирами нужен один мост — он здесь.
 *
 * Ключ строки в ките — ЕЁ НОМЕР (позиция в массиве), и это решение одно на всю
 * программу:
 *  - у строк карточек своего id чаще всего нет вовсе (строки договора, строки наряда,
 *    свойства инструмента), а выдуманный id пришлось бы где-то хранить и передёргивать
 *    при каждой правке — это вторая механика рядом с китом;
 *  - номер переживает перестановку сам по себе: после сдвига строки её номер меняется,
 *    поэтому блок «перемещаемые строки» пересчитывает свои номера по новому порядку
 *    (`remapKeys` в ките клавиатуры) — иначе второе нажатие стрелки сдвинуло бы уже
 *    ДРУГУЮ строку, ту, что встала на освободившееся место.
 */

/** Ключ строки в ките — её номер в массиве списка. */
export function rowKeyAt(index: number): string {
  return String(index);
}

/**
 * Новый массив строк в новом порядке.
 *
 * @param rows текущие строки списка (в текущем порядке)
 * @param order новый порядок — номера строк в новом порядке
 */
export function reorderRows<T>(rows: readonly T[], order: readonly string[]): T[] {
  if (!rows.length) return [];
  const next: T[] = [];
  const used = new Set<string>();
  for (const key of order) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) continue;
    if (used.has(key)) continue;
    used.add(key);
    next.push(rows[index]!);
  }
  // Строка, о которой новый порядок не сказал, не теряется молча: потеря строки хуже,
  // чем лишняя строка в конце.
  for (let index = 0; index < rows.length; index += 1) {
    const key = rowKeyAt(index);
    if (used.has(key)) continue;
    used.add(key);
    next.push(rows[index]!);
  }
  return next;
}

/**
 * Куда встала перетаскиваемая строка.
 *
 * Место вставки задаётся КЛЮЧОМ строки-цели и стороной («до» или «после»). Ключ, а не
 * индекс: экранный индекс места вставки считается по координатам, а список живёт в
 * своём массиве, и на странице с несколькими списками (карточка наряда: бригада,
 * подписи, строки работ) индексы не совпадают.
 */
export type ListDropPosition = 'before' | 'after';

/**
 * Новый порядок после перетаскивания строки.
 *
 * @param keys номера строк в текущем порядке
 * @param draggedKey номер перетаскиваемой строки
 * @param targetKey номер строки, рядом с которой отпустили
 * @param position «до» или «после» строки-цели
 */
export function insertKeyByTarget(
  keys: readonly string[],
  draggedKey: string,
  targetKey: string,
  position: ListDropPosition,
): string[] {
  if (!keys.includes(draggedKey)) return [...keys];
  // Отпустили строку на самой себе — порядок не меняется.
  if (targetKey === draggedKey) return [...keys];
  const rest = keys.filter((key) => key !== draggedKey);
  const at = rest.indexOf(targetKey);
  if (at < 0) return [...rest, draggedKey];
  const insertAt = position === 'before' ? at : at + 1;
  return [...rest.slice(0, insertAt), draggedKey, ...rest.slice(insertAt)];
}

/**
 * Пересчитать номера перемещаемого блока после перестановки.
 *
 * Старый номер строки после сдвига стал другим номером — блок обязан помнить, ГДЕ
 * теперь его строки, иначе следующее нажатие стрелки двигает не ту строку.
 */
export function remapBlockKeys(blockKeys: readonly string[], order: readonly string[]): string[] {
  return blockKeys.map((key) => {
    const at = order.indexOf(key);
    return at >= 0 ? rowKeyAt(at) : key;
  });
}

/**
 * Перенумеровать строки по их новому порядку — для списков, у которых порядок выражен
 * НОМЕРОМ строки (`lineNo`).
 *
 * Номер — это позиция, а не идентичность: он меняется при перестановке и обязан
 * меняться вместе с ней, иначе печать и отчёты покажут старый порядок.
 */
export function renumberRows<T extends { lineNo?: number }>(rows: readonly T[]): T[] {
  return rows.map((row, index) => (row.lineNo === index + 1 ? row : { ...row, lineNo: index + 1 }));
}
