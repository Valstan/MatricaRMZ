// Чтение содержимого файлов оператора — ОБЩИЙ модуль (Excel / Word / текст).
//
// ЗАЧЕМ ОТДЕЛЬНО. Разбор книг и документов был приватными функциями модуля «Поиск по
// файлам» (`fileSearchService.ts`). Как только действию агента понадобилось принять
// данные «в любом виде» (промт КАРМАНА #176: список, Excel, Word), второй ридер
// означал бы две копии правила чтения: одна чинит баг с датой в ячейке, вторая — нет.
// Поэтому чтение живёт здесь, а поиск по файлам и действие агента зовут его.
//
// Модуль ТОЛЬКО ЧИТАЕТ: функции записи в файлы нет ни одной.

import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as XLSX from '@e965/xlsx';

import { docxXmlToText, type FileSearchExcelSheet } from '@matricarmz/shared';

import { raceWithAbort } from './searchAbort.js';

/** Книга больше — читаем с потолка и говорим оператору, что прочитали не всё. */
export const FILE_CONTENT_MAX_BYTES = 64 * 1024 * 1024;
export const FILE_CONTENT_MAX_SHEET_ROWS = 20000;
export const FILE_CONTENT_MAX_COLUMNS = 60;

/**
 * Потолок на ЧТЕНИЕ ОДНОГО файла.
 *
 * Это страховка от «нечитаемого» файла (зависшая сетевая папка, битый том), а НЕ
 * ограничение поиска: потолка на весь поиск здесь нет (промт КАРМАНА #166), и отмена
 * рвёт чтение немедленно.
 */
export const FILE_CONTENT_READ_TIMEOUT_MS = 30000;

export class SourceReadError extends Error {}

/** Вид файла по расширению — тот же набор, что и у поиска по файлам. */
export type FileContentKind = 'excel' | 'word' | 'text';

export function classifyFileContentKind(filePath: string): FileContentKind | null {
  const ext = extname(String(filePath ?? '')).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls') return 'excel';
  if (ext === '.docx') return 'word';
  if (ext === '.txt' || ext === '.csv' || ext === '.tsv') return 'text';
  return null;
}

function excelCellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return formatExcelDate(value);
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (Array.isArray(rec.richText)) {
      return rec.richText.map((part) => String((part as { text?: unknown })?.text ?? '')).join('').trim();
    }
    if ('text' in rec) return String(rec.text ?? '').trim();
    if ('result' in rec) return excelCellText(rec.result);
    return '';
  }
  return String(value).trim();
}

function formatExcelDate(value: Date): string {
  const day = String(value.getDate()).padStart(2, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${value.getFullYear()}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await raceWithAbort(
      Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SourceReadError(message)), ms);
        }),
      ]),
      signal,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertFileReadable(path: string, signal?: AbortSignal): Promise<number> {
  let size = 0;
  try {
    const st = await raceWithAbort(stat(path), signal);
    if (!st.isFile()) throw new SourceReadError('Это не файл');
    size = st.size;
  } catch (e) {
    if (e instanceof SourceReadError) throw e;
    throw new SourceReadError('Файл недоступен — откройте его заново');
  }
  if (size > FILE_CONTENT_MAX_BYTES) {
    throw new SourceReadError(
      `Файл слишком большой (${Math.round(size / (1024 * 1024))} МБ) — модуль читает файлы до ${Math.round(
        FILE_CONTENT_MAX_BYTES / (1024 * 1024),
      )} МБ`,
    );
  }
  return size;
}

/**
 * Книга старого формата `.xls` (Excel 97–2003) — это OLE2-контейнер, а не zip:
 * `exceljs` его не читает в принципе. Разбирает его `@e965/xlsx` (SheetJS 0.20.x).
 *
 * Зачем: у оператора в «РМЗ» лежат десятки `.xls` — табели, «Дела ремонтов», —
 * и без них модуль молча отказывал на самом нужном файле.
 */
async function readLegacyXlsSheets(
  path: string,
  notes: string[],
  signal?: AbortSignal,
): Promise<FileSearchExcelSheet[]> {
  const buffer = await withTimeout(
    readFile(path),
    FILE_CONTENT_READ_TIMEOUT_MS,
    `Не удалось прочитать книгу за ${Math.round(FILE_CONTENT_READ_TIMEOUT_MS / 1000)} с — файл слишком большой или недоступен`,
    signal,
  );
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    throw new SourceReadError(`Файл .xls не прочитан: ${String(e)}`);
  }
  const sheets: FileSearchExcelSheet[] = [];
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const ref = String(worksheet['!ref'] ?? '');
    const range = ref ? XLSX.utils.decode_range(ref) : null;
    const collected: { rowNumber: number; values: string[] }[] = [];
    let truncated = false;
    if (range) {
      const lastRow = Math.min(range.e.r, range.s.r + FILE_CONTENT_MAX_SHEET_ROWS - 1);
      if (range.e.r > lastRow) truncated = true;
      for (let r = range.s.r; r <= lastRow; r += 1) {
        const values: string[] = [];
        const lastCol = Math.min(range.e.c, FILE_CONTENT_MAX_COLUMNS - 1);
        for (let c = range.s.c; c <= lastCol; c += 1) {
          values.push(xlsCellText(worksheet[XLSX.utils.encode_cell({ r, c })]));
        }
        while (values.length > 0 && values[values.length - 1] === '') values.pop();
        if (values.length === 0) continue;
        collected.push({ rowNumber: r + 1, values });
      }
    }
    if (truncated) {
      notes.push(
        `«${sheetName}»: прочитаны первые ${FILE_CONTENT_MAX_SHEET_ROWS} строк — остальные не просмотрены`,
      );
    }
    const { headers, dataRows } = pickHeaderAndRows(collected);
    sheets.push({ sheetName, headers, rows: dataRows });
  }
  return sheets;
}

function xlsCellText(cell: unknown): string {
  if (cell == null || typeof cell !== 'object') return '';
  const record = cell as { v?: unknown; w?: unknown; t?: unknown };
  const value = record.v;
  if (value == null) return '';
  if (value instanceof Date) return formatExcelDate(value);
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim();
}

/**
 * Шапка таблицы — первая строка с двумя и более заполненными ячейками.
 *
 * Зачем: выгрузки 1С начинаются титулом («ЖУРНАЛ», «учёта дел ремонта…»), и
 * шапка столбцов стоит ниже. Раньше первой непустой строкой считалась титульная
 * — и в находках вместо названий столбцов оператор видел «ЖУРНАЛ».
 */
const HEADER_SCAN_ROWS = 20;

function countFilled(values: string[]): number {
  return values.filter((value) => value.trim().length > 0).length;
}

function pickHeaderAndRows(rows: { rowNumber: number; values: string[] }[]): {
  headers: string[];
  dataRows: { rowNumber: number; values: string[] }[];
} {
  const window = rows.slice(0, HEADER_SCAN_ROWS);
  const candidate = window.find((r) => countFilled(r.values) >= 2);
  const header = candidate ?? window[0] ?? null;
  if (!header) return { headers: [], dataRows: [] };
  const headerFill = countFilled(header.values);
  // Шапка до ширины данных: у книг с объединёнными ячейками она короче, и без
  // дополнения столбцы уезжают в «Столбец N».
  const maxLen = rows.reduce((max, r) => Math.max(max, r.values.length), header.values.length);
  const headers = [...header.values];
  while (headers.length < maxLen) headers.push('');
  // Подшапка: строка ниже шапки с меньшим числом заполненных ячеек. В выгрузках 1С
  // «Двигатель» — объединённая группа, а под ним «Марка», «заводской номер».
  // Пустую ячейку шапки берём из подшапки, иначе столбец остаётся «Столбец N».
  const sub = window.find(
    (r) =>
      r.rowNumber > header.rowNumber && countFilled(r.values) >= 2 && countFilled(r.values) < headerFill,
  );
  if (sub) {
    for (let i = 0; i < headers.length; i += 1) {
      if (headers[i]) continue;
      const value = sub.values[i];
      if (value) headers[i] = value;
    }
  }
  return {
    headers,
    dataRows: rows.filter((r) => r.rowNumber > header.rowNumber),
  };
}

/** Листы книги — как их видит поиск по файлам. */
export async function readExcelSheets(
  path: string,
  notes: string[],
  signal?: AbortSignal,
): Promise<FileSearchExcelSheet[]> {
  await assertFileReadable(path, signal);
  if (extname(path).toLowerCase() === '.xls') return readLegacyXlsSheets(path, notes, signal);
  const workbook = new ExcelJS.Workbook();
  await withTimeout(
    workbook.xlsx.readFile(path),
    FILE_CONTENT_READ_TIMEOUT_MS,
    `Не удалось прочитать книгу за ${Math.round(FILE_CONTENT_READ_TIMEOUT_MS / 1000)} с — файл слишком большой или недоступен`,
    signal,
  );
  const sheets: FileSearchExcelSheet[] = [];
  workbook.eachSheet((worksheet) => {
    const collected: { rowNumber: number; values: string[] }[] = [];
    let truncated = false;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (collected.length >= FILE_CONTENT_MAX_SHEET_ROWS) {
        truncated = true;
        return;
      }
      const cellCount = Math.min(row.cellCount ?? 0, FILE_CONTENT_MAX_COLUMNS);
      const values: string[] = [];
      for (let c = 1; c <= cellCount; c += 1) values.push(excelCellText(row.getCell(c).value));
      while (values.length > 0 && values[values.length - 1] === '') values.pop();
      if (values.length === 0) return;
      collected.push({ rowNumber, values });
    });
    if (truncated) {
      notes.push(
        `«${worksheet.name}»: прочитаны первые ${FILE_CONTENT_MAX_SHEET_ROWS} строк — остальные не просмотрены`,
      );
    }
    const { headers, dataRows } = pickHeaderAndRows(collected);
    sheets.push({ sheetName: worksheet.name, headers, rows: dataRows });
  });
  return sheets;
}

/** Абзацы документа Word. */
export async function readWordParagraphs(path: string, signal?: AbortSignal): Promise<string[]> {
  await assertFileReadable(path, signal);
  const buffer = await withTimeout(
    readFile(path),
    FILE_CONTENT_READ_TIMEOUT_MS,
    `Не удалось прочитать документ за ${Math.round(FILE_CONTENT_READ_TIMEOUT_MS / 1000)} с — файл слишком большой или недоступен`,
    signal,
  );
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new SourceReadError('Файл .docx повреждён: внутри нет документа');
  const xml = await doc.async('string');
  const text = docxXmlToText(xml);
  return text.split('\n');
}

/** Строки текстового файла. */
export async function readTextLines(path: string, signal?: AbortSignal): Promise<string[]> {
  await assertFileReadable(path, signal);
  const buffer = await withTimeout(
    readFile(path),
    FILE_CONTENT_READ_TIMEOUT_MS,
    `Не удалось прочитать файл за ${Math.round(FILE_CONTENT_READ_TIMEOUT_MS / 1000)} с — файл слишком большой или недоступен`,
    signal,
  );
  return new TextDecoder('utf-8').decode(buffer).split(/\r?\n/);
}

/**
 * Содержимое файла — строкой. Для книги это все заполненные ячейки (как есть, по
 * строкам), для документа — абзацы, для текста — строки.
 *
 * Этим читает действие агента: ему нужен не «лист с шапкой», а плоский текст, из
 * которого вынимаются номера двигателей. Правила разбора шапки поиска по файлам его
 * не касаются.
 */
export async function readFileContentText(
  path: string,
  signal?: AbortSignal,
): Promise<{ kind: FileContentKind; text: string }> {
  const kind = classifyFileContentKind(path);
  if (!kind) {
    throw new SourceReadError(
      'Файл не поддерживается: нужна книга Excel, документ Word или текстовый файл',
    );
  }
  if (kind === 'text') {
    const lines = await readTextLines(path, signal);
    return { kind, text: lines.join('\n') };
  }
  if (kind === 'word') {
    const lines = await readWordParagraphs(path, signal);
    return { kind, text: lines.join('\n') };
  }
  const notes: string[] = [];
  const sheets = await readExcelSheets(path, notes, signal);
  const lines: string[] = [];
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const line = row.values.filter((value) => value.trim().length > 0).join(' ');
      if (line.trim()) lines.push(line);
    }
  }
  return { kind, text: lines.join('\n') };
}
