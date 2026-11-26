import { escapeHtml } from './printPreview.js';
import type { ListPrintColumn } from '../components/ListPrintDialog.js';

/**
 * Печатная таблица списка — **один сборщик на все места** (промт КАРМАНА #164).
 *
 * Раньше печать из тулбара, печать из контекстного меню и выгрузка в файл собирали ряд
 * каждый по-своему, и группировка «Заказчик → договор» доезжала только до экрана: на лист
 * уходил плоский отсортированный список, и связь «эти строки — под этим заказчиком»
 * терялась. Теперь ряд (строки + заголовки групп) приходит из домена (`listGrouping.ts`),
 * а этот сборщик превращает его в HTML — печать, контекстное меню и файл берут **один и тот
 * же** ряд, и новый разрез доезжает до всех мест сразу.
 *
 * Ряды бывают двух видов:
 *  - **сгруппированный** — `listGrouping.ts`: заголовки групп и строки вперемешку, как на
 *    экране (порядок групп, вложенность, номера);
 *  - **плоский** — `flatRowsToPrintItems`: для списков без группировки и для отчётов, чей
 *    вид менять нельзя (промт: «Отчёты не изменились»).
 */

/** Строка печатного ряда: заголовок группы или строка данных. */
export type ListPrintItem<T> =
  | { kind: 'group'; label: string; depth: number; count: number }
  | { kind: 'row'; row: T; number: number; groupNumber: number | null };

/** Какие колонки-номера печатать: обе настраиваемые (промт КАРМАНА #164). */
export type ListPrintNumberColumns = { number: boolean; groupNumber: boolean };

/** Сколько колонок-номеров включено — столько же ячеек в строке заголовка группы. */
export function listPrintNumberColumnCount(numberColumns: ListPrintNumberColumns): number {
  return (numberColumns.number ? 1 : 0) + (numberColumns.groupNumber ? 1 : 0);
}

/**
 * Плоский ряд → ряд для печати.
 *
 * Заголовок группы ставится там, где меняется подпись группы (`rowGroupLabel`): так печатали
 * отчёты до сих пор — одна строка-подпись «Заказчик › Договор» перед первой строкой новой
 * группы. Группировки нет — ряд состоит только из строк.
 */
export function flatRowsToPrintItems<T>(
  rows: readonly T[],
  rowGroupLabel?: (row: T) => string | null,
): ListPrintItem<T>[] {
  const items: ListPrintItem<T>[] = [];
  let lastGroup: string | null = null;
  rows.forEach((row, index) => {
    const group = rowGroupLabel ? rowGroupLabel(row) : null;
    if (group != null && group !== lastGroup) {
      items.push({ kind: 'group', label: group, depth: 0, count: 0 });
    }
    lastGroup = group;
    items.push({ kind: 'row', row, number: index + 1, groupNumber: null });
  });
  return items;
}

/**
 * Шапка и тело печатной таблицы.
 *
 * Заголовок группы — строка на всю ширину, с отступом по глубине вложенности. Нумерация
 * строк: сквозная идёт первой колонкой, групповая — второй; обе выключаются, и тогда
 * колонки нет вовсе (в том числе в шапке).
 */
export function buildListPrintTableHtml<T>(args: {
  items: readonly ListPrintItem<T>[];
  fields: readonly ListPrintColumn<T>[];
  numberColumns: ListPrintNumberColumns;
  /** Фон строки на бумаге (розовая пометка утиля) — по строке, не по группе. */
  rowBackground?: (row: T) => string | undefined;
}): { thead: string; tbody: string } {
  const { numberColumns } = args;
  const numberHeaders = [
    ...(numberColumns.number ? ['<th style="text-align:right">№</th>'] : []),
    ...(numberColumns.groupNumber ? ['<th style="text-align:right">№ в группе</th>'] : []),
  ].join('');
  const thead = `${numberHeaders}${args.fields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('')}`;

  const colSpan = args.fields.length + listPrintNumberColumnCount(numberColumns);
  const tbody = args.items
    .map((item) => {
      if (item.kind === 'group') {
        const indent = item.depth > 0 ? `padding-left:${8 + item.depth * 18}px;` : '';
        const count = item.count > 0 ? ` · ${item.count}` : '';
        return `<tr><td colspan="${colSpan}" style="font-weight:600;background:#f3f4f6;${indent}">${escapeHtml(item.label)}${count}</td></tr>`;
      }
      const numberCells = [
        ...(numberColumns.number ? [`<td style="text-align:right">${item.number}</td>`] : []),
        ...(numberColumns.groupNumber ? [`<td style="text-align:right">${item.groupNumber ?? ''}</td>`] : []),
      ].join('');
      // Фон строки (розовая пометка утиля) — инлайном: в печатном окне стили таблицы
      // перебиваются, а фон строки должен пережить и перерисовку.
      const bg = args.rowBackground?.(item.row);
      const rowStyle = bg ? ` style="background:${escapeHtml(bg)}"` : '';
      const cells = args.fields.map((f) => `<td>${escapeHtml(f.printValue(item.row) || '—')}</td>`).join('');
      return `<tr${rowStyle}>${numberCells}${cells}</tr>`;
    })
    .join('');

  return { thead, tbody };
}

/**
 * Отбор строк для печати: оставить только отобранные строки, а заголовки групп — те, у
 * которых под заголовком что-то осталось. Заголовок группы без строк — мусор на листе.
 */
export function filterPrintItemsBySelection<T>(
  items: readonly ListPrintItem<T>[],
  selectedRows: readonly T[],
  rowSelected?: (row: T) => boolean,
): ListPrintItem<T>[] {
  const selected = new Set<T>(selectedRows);
  const isSelected = (row: T) => (rowSelected ? rowSelected(row) : selected.has(row));
  const kept: ListPrintItem<T>[] = [];
  let pending: ListPrintItem<T>[] = [];
  for (const item of items) {
    if (item.kind === 'group') {
      pending.push(item);
      continue;
    }
    if (!isSelected(item.row)) continue;
    kept.push(...pending, item);
    pending = [];
  }
  return kept;
}

/**
 * Ограничение «первые N строк»: считаются **строки данных**, заголовки групп идут вместе
 * со своими строками. Ограничить надо именно строки — иначе половина листа может оказаться
 * без данных.
 */
export function limitPrintItems<T>(items: readonly ListPrintItem<T>[], limit: number): ListPrintItem<T>[] {
  const out: ListPrintItem<T>[] = [];
  let count = 0;
  let pending: ListPrintItem<T>[] = [];
  for (const item of items) {
    if (item.kind === 'group') {
      pending.push(item);
      continue;
    }
    if (count >= limit) break;
    out.push(...pending, item);
    pending = [];
    count += 1;
  }
  return out;
}

/**
 * Текст для буфера — тот же ряд, что и на печати: заголовки групп идут между строками.
 *
 * Формат строки — как в общем `buildRowsText` («подпись: значение | подпись: значение»), а
 * заголовок группы — своей строкой. Копирование из контекстного меню и печать из тулбара
 * обязаны показывать одно и то же, иначе оператор вставит в таблицу одно, а на лист
 * положит другое.
 */
export function buildListPrintItemsText<T>(args: {
  items: readonly ListPrintItem<T>[];
  columns: ReadonlyArray<{ title: string; value: (row: T) => string }>;
}): string {
  const lines: string[] = [];
  for (const item of args.items) {
    if (item.kind === 'group') {
      lines.push(`— ${item.label} —`);
      continue;
    }
    lines.push(args.columns.map((column) => `${column.title}: ${normalizeCellText(column.value(item.row))}`).join(' | '));
  }
  return lines.join('\n');
}

function normalizeCellText(value: unknown): string {
  if (value == null) return '—';
  const text = String(value).trim();
  return text || '—';
}
