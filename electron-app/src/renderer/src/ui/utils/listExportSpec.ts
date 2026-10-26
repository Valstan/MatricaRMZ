import { HUMAN_LABEL_DASH, humanCellText, inferListExportKind, type ListExportSpec } from '@matricarmz/shared';

import type { ListPrintColumn } from '../components/ListPrintDialog.js';

/** Сколько строк смотрим, чтобы понять тип колонки: тип виден на первых строках, а список бывает огромным. */
const KIND_SAMPLE_ROWS = 200;

/**
 * Список глазами файла: те же колонки и строки, что уходят на печать, плюс тип каждой колонки.
 * Первой идёт «№» — как на экране и на листе; ширины приходят из планировщика печати, чтобы
 * документ Word повторил раскладку листа, а не разложился заново по-своему.
 */
export function buildListExportSpec<T>(args: {
  title: string;
  fields: ListPrintColumn<T>[];
  rows: T[];
  filters: readonly string[];
  meta?: string;
  columnWidthsMm?: readonly number[];
  fileBaseName?: string;
}): ListExportSpec {
  const cell = (field: ListPrintColumn<T>, row: T) => humanCellText(field.printValue(row));
  const sample = args.rows.slice(0, KIND_SAMPLE_ROWS);
  const columns = [
    { label: '№', kind: 'number' as const },
    ...args.fields.map((field) => ({
      label: field.label,
      kind: inferListExportKind(
        field.label,
        sample.map((row) => cell(field, row)),
      ),
    })),
  ];
  const rows = args.rows.map((row, index) => [String(index + 1), ...args.fields.map((f) => cell(f, row) || HUMAN_LABEL_DASH)]);
  // Строки шапки — тоже текст файла: если страница собрала их из идентификаторов, сетка
  // снимет их здесь, а не оставит в выгрузке.
  const filters = args.filters.map((line) => humanCellText(line)).filter(Boolean);

  return {
    title: args.title,
    filters,
    columns,
    rows,
    fileBaseName: args.fileBaseName ?? args.title,
    ...(args.meta ? { meta: args.meta } : {}),
    ...(args.columnWidthsMm ? { columnWidthsMm: [...args.columnWidthsMm] } : {}),
  };
}
