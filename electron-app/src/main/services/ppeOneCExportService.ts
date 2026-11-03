/**
 * Выгрузка СИЗ для 1С: XLSX и CSV по ФИКСИРОВАННОЙ структуре.
 *
 * Зачем отдельный сервис, а не обычный экспорт списка:
 *  - файл читает бухгалтер и загружает в свою 1С (ЗУП/УТ) — структура колонок
 *    должна быть известна заранее и не «плыть» вместе с настройками экрана;
 *  - в данных не должно быть служебных идентификаторов: только человекочитаемые
 *    названия (ФИО, должность, подразделение, наименование СИЗ, пункт приказа);
 *  - даты в формате ДД.ММ.ГГГГ — как их ждёт 1С при загрузке.
 *
 * Два файла:
 *  (а) «Нормы выдачи» — справочник: одна строка на позицию нормы (что положено);
 *  (б) «Выдача за период» — факты: одна строка на выданную позицию (что выдали).
 */
import ExcelJS from 'exceljs';

import { sanitizeExportFileName } from '@matricarmz/shared';

const DAY_FORMAT = 'dd.mm.yyyy';

/** Колонки файла «Нормы выдачи» — порядок фиксирован и не зависит от экрана. */
export const PPE_ONE_C_NORM_COLUMNS = [
  'Табельный номер',
  'ФИО',
  'Должность',
  'Подразделение',
  'Наименование СИЗ',
  'Пункт ТОН',
  'Тип СИЗ',
  'Ед. изм.',
  'Кол-во на год',
  'Срок носки',
  'Размер',
] as const;

/** Колонки файла «Выдача за период» — порядок фиксирован. */
export const PPE_ONE_C_ISSUE_COLUMNS = [
  'Табельный номер',
  'ФИО',
  'Должность',
  'Подразделение',
  'Наименование СИЗ',
  'Размер',
  'Кол-во',
  'Дата выдачи',
  'Основание (документ)',
  'Срок службы',
] as const;

export type PpeOneCNormRow = {
  personnelNo: string;
  fullName: string;
  postTitle: string;
  departmentName: string;
  itemName: string;
  sourceLabel: string;
  ppeType: string;
  unit: string;
  qty: number;
  wearPeriod: string;
  size: string;
};

export type PpeOneCIssueRow = {
  personnelNo: string;
  fullName: string;
  postTitle: string;
  departmentName: string;
  itemName: string;
  size: string;
  qty: number;
  issuedAt: number;
  documentNo: string;
  wearPeriod: string;
};

/** Ячейка файла: текст, число или дата — типы различаем явно, чтобы Excel считал. */
type Cell = string | number | Date;

function toRows(
  columns: readonly string[],
  rows: Array<Record<string, Cell>>,
): Array<Record<string, Cell>> {
  // Порядок колонок задаётся здесь: строки приходят объектами с теми же ключами.
  return rows.map((row) => {
    const out: Record<string, Cell> = {};
    for (const col of columns) out[col] = row[col] ?? '';
    return out;
  });
}

/** Заголовки колонок — одной строкой после шапки. */
function buildWorkbook(title: string, period: string, who: string, columns: readonly string[], rows: Array<Record<string, Cell>>): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MatricaRMZ';
  const ws = wb.addWorksheet(sanitizeExportFileName(title).slice(0, 31) || 'СИЗ');
  ws.addRow([title]);
  ws.getCell('A1').font = { bold: true, size: 12 };
  ws.addRow(['Период', period]);
  ws.addRow(['Сформировал', who]);
  ws.addRow([]);
  ws.addRow([...columns]);
  const headerRow = ws.getRow(5);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.alignment = { vertical: 'top', wrapText: true };
  });
  for (const row of toRows(columns, rows)) {
    const added = ws.addRow(columns.map((col) => row[col]));
    added.eachCell((cell) => {
      if (cell.value instanceof Date) cell.numFmt = DAY_FORMAT;
      cell.alignment = { vertical: 'top' };
    });
  }
  // Ширина колонок — по содержимому, ограничение сверху: файл читают и считают.
  columns.forEach((col, i) => {
    let width = String(col).length + 2;
    for (const row of rows.slice(0, 500)) {
      const v = row[col];
      const len = v instanceof Date ? 10 : String(v ?? '').length;
      if (len + 2 > width) width = len + 2;
    }
    ws.getColumn(i + 1).width = Math.min(60, width);
  });
  ws.views = [{ state: 'frozen', ySplit: 5 }];
  return wb;
}

/** Файл «Нормы выдачи» (справочник): что положено сотруднику по нормам приказа. */
export async function buildPpeOneCNormsWorkbook(args: {
  period: string;
  who: string;
  rows: PpeOneCNormRow[];
}): Promise<Buffer> {
  const wb = buildWorkbook(
    'Нормы выдачи СИЗ',
    args.period,
    args.who,
    PPE_ONE_C_NORM_COLUMNS,
    args.rows.map((r) => ({
      'Табельный номер': r.personnelNo,
      'ФИО': r.fullName,
      'Должность': r.postTitle,
      'Подразделение': r.departmentName,
      'Наименование СИЗ': r.itemName,
      'Пункт ТОН': r.sourceLabel,
      'Тип СИЗ': r.ppeType,
      'Ед. изм.': r.unit,
      'Кол-во на год': r.qty,
      'Срок носки': r.wearPeriod,
      'Размер': r.size,
    })),
  );
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** Файл «Выдача за период» (факты): что фактически выдали. */
export async function buildPpeOneCIssuesWorkbook(args: {
  period: string;
  who: string;
  rows: PpeOneCIssueRow[];
}): Promise<Buffer> {
  const wb = buildWorkbook(
    'Выдача СИЗ за период',
    args.period,
    args.who,
    PPE_ONE_C_ISSUE_COLUMNS,
    args.rows.map((r) => ({
      'Табельный номер': r.personnelNo,
      'ФИО': r.fullName,
      'Должность': r.postTitle,
      'Подразделение': r.departmentName,
      'Наименование СИЗ': r.itemName,
      'Размер': r.size,
      'Кол-во': r.qty,
      'Дата выдачи': new Date(r.issuedAt),
      'Основание (документ)': r.documentNo,
      'Срок службы': r.wearPeriod,
    })),
  );
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * CSV с разделителем «;» — так его ждёт 1С при загрузке «внешних данных».
 * Без BOM: он ломает первую колонку заголовка (Excel и 1С видят её как «Табельный
 * номер» с невидимым префиксом). Кодировка — UTF-8, её 1С открывает без настройки
 * импорта.
 */
function toCsv(columns: readonly string[], rows: Array<Record<string, Cell>>): string {
  const cell = (v: Cell): string => {
    if (v instanceof Date) {
      const d = v.getDate().toString().padStart(2, '0');
      const m = (v.getMonth() + 1).toString().padStart(2, '0');
      return `${d}.${m}.${v.getFullYear()}`;
    }
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(cell).join(';')];
  for (const row of toRows(columns, rows)) lines.push(columns.map((col) => cell(row[col] ?? '')).join(';'));
  return `${lines.join('\r\n')}\r\n`;
}

/** CSV-вариант того же файла — для загрузки в 1С через «внешние данные». */
export function buildPpeOneCNormsCsv(args: { rows: PpeOneCNormRow[] }): Buffer {
  return Buffer.from(
    toCsv(
      PPE_ONE_C_NORM_COLUMNS,
      args.rows.map((r) => ({
        'Табельный номер': r.personnelNo,
        'ФИО': r.fullName,
        'Должность': r.postTitle,
        'Подразделение': r.departmentName,
        'Наименование СИЗ': r.itemName,
        'Пункт ТОН': r.sourceLabel,
        'Тип СИЗ': r.ppeType,
        'Ед. изм.': r.unit,
        'Кол-во на год': r.qty,
        'Срок носки': r.wearPeriod,
        'Размер': r.size,
      })),
    ),
    'utf8',
  );
}

export function buildPpeOneCIssuesCsv(args: { rows: PpeOneCIssueRow[] }): Buffer {
  return Buffer.from(
    toCsv(
      PPE_ONE_C_ISSUE_COLUMNS,
      args.rows.map((r) => ({
        'Табельный номер': r.personnelNo,
        'ФИО': r.fullName,
        'Должность': r.postTitle,
        'Подразделение': r.departmentName,
        'Наименование СИЗ': r.itemName,
        'Размер': r.size,
        'Кол-во': r.qty,
        'Дата выдачи': new Date(r.issuedAt),
        'Основание (документ)': r.documentNo,
        'Срок службы': r.wearPeriod,
      })),
    ),
    'utf8',
  );
}
