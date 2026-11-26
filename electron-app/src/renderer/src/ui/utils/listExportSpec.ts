import {
  DEFAULT_LIST_NUMBER_COLUMNS,
  HUMAN_LABEL_DASH,
  humanCellText,
  inferListExportKind,
  type ListExportGroup,
  type ListExportSpec,
} from '@matricarmz/shared';

import type { ListPrintColumn } from '../components/ListPrintDialog.js';
import { flatRowsToPrintItems, type ListPrintItem, type ListPrintNumberColumns } from './listPrintTable.js';

/** Сколько строк смотрим, чтобы понять тип колонки: тип виден на первых строках, а список бывает огромным. */
const KIND_SAMPLE_ROWS = 200;

/**
 * Список глазами файла: те же колонки и строки, что уходят на печать, плюс тип каждой колонки.
 * Первой идёт «№» — как на экране и на листе; ширины приходят из планировщика печати, чтобы
 * документ Word повторил раскладку листа, а не разложился заново по-своему.
 *
 * Промт КАРМАНА #164: файл повторяет **группировку** списка — заголовки групп и строки
 * внутри своих групп (раньше файл был плоской сеткой, и связь «эти строки — под этим
 * заказчиком» терялась). Колонки-номера приходят настраиваемыми: отключённая не выгружается.
 */
export function buildListExportSpec<T>(args: {
  title: string;
  fields: ListPrintColumn<T>[];
  rows: T[];
  filters: readonly string[];
  meta?: string;
  columnWidthsMm?: readonly number[];
  fileBaseName?: string;
  /** Сгруппированный ряд (заголовки групп + строки) — как на экране. Нет — ряд плоский. */
  items?: readonly ListPrintItem<T>[];
  /** Колонки-номера в файле: по умолчанию — сквозная «№». */
  numberColumns?: ListPrintNumberColumns;
}): ListExportSpec {
  const cell = (field: ListPrintColumn<T>, row: T) => humanCellText(field.printValue(row));
  const numberColumns = args.numberColumns ?? DEFAULT_LIST_NUMBER_COLUMNS;
  const items = args.items ?? flatRowsToPrintItems(args.rows);
  const dataItems = items.filter((item): item is Extract<ListPrintItem<T>, { kind: 'row' }> => item.kind === 'row');
  const sample = dataItems.slice(0, KIND_SAMPLE_ROWS).map((item) => item.row);

  const columns = [
    ...(numberColumns.number ? [{ label: '№', kind: 'number' as const }] : []),
    ...(numberColumns.groupNumber ? [{ label: '№ в группе', kind: 'number' as const }] : []),
    ...args.fields.map((field) => ({
      label: field.label,
      kind: inferListExportKind(
        field.label,
        sample.map((row) => cell(field, row)),
      ),
    })),
  ];
  const rows = dataItems.map((item) => [
    ...(numberColumns.number ? [String(item.number)] : []),
    ...(numberColumns.groupNumber ? [item.groupNumber == null ? '' : String(item.groupNumber)] : []),
    ...args.fields.map((f) => cell(f, item.row) || HUMAN_LABEL_DASH),
  ]);

  // Заголовки групп: у каждого — индекс строки данных, перед которой он стоит.
  const groups: ListExportGroup[] = [];
  let rowIndex = 0;
  for (const item of items) {
    if (item.kind === 'group') {
      groups.push({ rowIndex, label: item.label, depth: item.depth });
      continue;
    }
    rowIndex += 1;
  }

  // Строки отбора — тоже текст файла: если страница собрала их из идентификаторов, сетка
  // снимет их здесь, а не оставит в выгрузке.
  const filters = args.filters.map((line) => humanCellText(line)).filter(Boolean);

  return {
    title: args.title,
    filters,
    columns,
    rows,
    ...(groups.length > 0 ? { groups } : {}),
    fileBaseName: args.fileBaseName ?? args.title,
    ...(args.meta ? { meta: args.meta } : {}),
    ...(args.columnWidthsMm ? { columnWidthsMm: [...args.columnWidthsMm] } : {}),
  };
}
