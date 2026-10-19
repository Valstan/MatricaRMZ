// Выгрузка списка в Excel и Word. Собирается в main-процессе: `exceljs` и `docx` — серверные
// библиотеки, в рендерере им не место. Рендерер отдаёт готовый `ListExportSpec` (колонки,
// строки текстом, отбор), здесь текст превращается в настоящие числа и даты — иначе в Excel
// по колонке «Сумма» не считается СУММ, а «19.10.2026» остаётся строкой и сортируется
// по алфавиту. Word получает ту же раскладку, что печатный лист: ширины приходят из
// планировщика печати (`columnWidthsMm`), а не считаются здесь заново.
import {
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';

import {
  parseExportDate,
  parseExportNumber,
  sanitizeExportFileName,
  type ListExportCellKind,
  type ListExportSpec,
} from '@matricarmz/shared';

import { APP_NAME, MARGIN_TWIPS, MM_TO_TWIPS, PAGE_TWIPS, xmlSafe } from './exportCommon.js';

const NUMBER_FORMAT = '#,##0.###';
const DAY_FORMAT = 'dd.mm.yyyy';
const MINUTE_FORMAT = 'dd.mm.yyyy hh:mm';

/** Числа и даты — настоящими значениями, не разобралось — текстом: соврать дороже. */
function typedCell(kind: ListExportCellKind, text: string): { value: string | number | Date; numFmt?: string } {
  const raw = xmlSafe(text);
  if (kind === 'number') {
    const n = parseExportNumber(text);
    if (n !== null) return { value: n, numFmt: NUMBER_FORMAT };
  }
  if (kind === 'date') {
    const d = parseExportDate(text);
    if (d) return { value: d.date, numFmt: d.hasTime ? MINUTE_FORMAT : DAY_FORMAT };
  }
  return { value: raw };
}

/** Ширина листа Excel считается по содержимому, а не по печатной раскладке: этот файл
 * читают и считают, и обрезанная на экране ячейка врёт сильнее, чем непохожий на лист вид. */
const MAX_COL_WIDTH = 60;
const WIDTH_SAMPLE_ROWS = 500;

function sheetName(title: string): string {
  return sanitizeExportFileName(title).slice(0, 31) || 'Список';
}

export async function buildListWorkbook(spec: ListExportSpec): Promise<Buffer> {
  if (spec.columns.length === 0) throw new Error('в списке нет ни одной колонки');

  const wb = new ExcelJS.Workbook();
  wb.creator = APP_NAME;
  const ws = wb.addWorksheet(sheetName(spec.title));
  const width = spec.columns.length;

  const titleRow = ws.addRow([xmlSafe(spec.title)]);
  titleRow.font = { bold: true, size: 14 };
  if (width > 1) ws.mergeCells(titleRow.number, 1, titleRow.number, width);

  for (const line of spec.filters) {
    ws.addRow([xmlSafe(line)]).font = { color: { argb: 'FF666666' } };
  }
  if (spec.meta) ws.addRow([xmlSafe(spec.meta)]).font = { color: { argb: 'FF666666' } };
  if (spec.filters.length > 0 || spec.meta) ws.addRow([]);

  const headerRow = ws.addRow(spec.columns.map((c) => xmlSafe(c.label)));
  headerRow.height = 28;
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });

  spec.rows.forEach((row) => {
    const values = spec.columns.map((col, i) => typedCell(col.kind, row[i] ?? '').value);
    const added = ws.addRow(values);
    spec.columns.forEach((col, i) => {
      const cell = added.getCell(i + 1);
      const fmt = typedCell(col.kind, row[i] ?? '').numFmt;
      if (fmt) cell.numFmt = fmt;
    });
  });

  spec.columns.forEach((col, i) => {
    let longest = col.label.length;
    for (const row of spec.rows.slice(0, WIDTH_SAMPLE_ROWS)) {
      longest = Math.max(longest, String(row[i] ?? '').length);
    }
    ws.getColumn(i + 1).width = Math.min(MAX_COL_WIDTH, Math.max(9, longest + 2));
  });

  // Закреплены и шапка, и строки отбора над ней: без них при прокрутке непонятно, чей это
  // список и по какому отбору он выгружен.
  ws.views = [{ state: 'frozen', ySplit: headerRow.number }];
  ws.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number + spec.rows.length, column: width },
  };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

const MIN_COLUMN_TWIPS = 300;

/** Word не понимает ширину таблицы в процентах (`w:tblW type="pct"`) — только твипы (M80). */
export async function buildListDocument(spec: ListExportSpec): Promise<Buffer> {
  if (spec.columns.length === 0) throw new Error('в списке нет ни одной колонки');

  const widthsMm = spec.columnWidthsMm?.length === spec.columns.length ? spec.columnWidthsMm : null;
  const layoutMm = widthsMm ? widthsMm.reduce((sum, mm) => sum + mm, 0) : 186;
  const landscape = layoutMm > 200;
  const page = landscape ? PAGE_TWIPS.landscape : PAGE_TWIPS.portrait;
  const contentTwips = page.width - MARGIN_TWIPS * 2;

  const columnTwips = widthsMm
    ? widthsMm.map((mm) => Math.max(MIN_COLUMN_TWIPS, Math.round(mm * MM_TO_TWIPS)))
    : spec.columns.map(() => Math.round(contentTwips / spec.columns.length));
  // Сумма ширин колонок обязана совпасть с шириной таблицы: иначе Word растянет одну
  // из них сам и раскладка разъедется с листом.
  const drift = contentTwips - columnTwips.reduce((sum, w) => sum + w, 0);
  const last = columnTwips.length - 1;
  columnTwips[last] = Math.max(MIN_COLUMN_TWIPS, columnTwips[last]! + drift);

  const cell = (text: string, options: { bold?: boolean; shaded?: boolean } = {}) =>
    new TableCell({
      ...(options.shaded ? { shading: { fill: 'EFEFEF' } } : {}),
      children: [
        new Paragraph({
          children: [new TextRun({ text: xmlSafe(text), size: 18, ...(options.bold ? { bold: true } : {}) })],
        }),
      ],
    });

  const table = new Table({
    width: { size: contentTwips, type: WidthType.DXA },
    columnWidths: columnTwips,
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: '999999' },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: '999999' },
      left: { style: BorderStyle.SINGLE, size: 2, color: '999999' },
      right: { style: BorderStyle.SINGLE, size: 2, color: '999999' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: '999999' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: '999999' },
    },
    rows: [
      new TableRow({ tableHeader: true, children: spec.columns.map((col) => cell(col.label, { bold: true, shaded: true })) }),
      ...spec.rows.map((row) => new TableRow({ children: spec.columns.map((_, i) => cell(row[i] ?? '')) })),
    ],
  });

  const children = [
    new Paragraph({ children: [new TextRun({ text: xmlSafe(spec.title), bold: true, size: 28 })] }),
    ...spec.filters.map(
      (line) => new Paragraph({ children: [new TextRun({ text: xmlSafe(line), size: 18, color: '666666' })] }),
    ),
    ...(spec.meta ? [new Paragraph({ children: [new TextRun({ text: xmlSafe(spec.meta), size: 18, color: '666666' })] })] : []),
    new Paragraph({ text: '' }),
    table,
    // Пустой абзац после таблицы обязателен: документ, кончающийся таблицей, Word 2007
    // тоже объявляет повреждённым (M80).
    new Paragraph({ text: '' }),
  ];

  const doc = new Document({
    creator: APP_NAME,
    sections: [
      {
        properties: { page: { size: page, margin: { top: MARGIN_TWIPS, bottom: MARGIN_TWIPS, left: MARGIN_TWIPS, right: MARGIN_TWIPS } } },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export function exportFileExtension(format: 'xlsx' | 'docx'): string {
  return format === 'xlsx' ? '.xlsx' : '.docx';
}
