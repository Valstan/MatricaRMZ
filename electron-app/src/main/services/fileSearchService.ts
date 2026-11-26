// Чтение файлов оператора для модуля «Поиск по файлам» (промт КАРМАНА #32).
//
// Файловая система — здесь, в main: renderer не читает файлы и не держит
// «примитив прочитать любой файл с диска» (прецедент — `filesReadPastableText`).
// Модуль ТОЛЬКО ЧИТАЕТ: функции записи в выбранные файлы нет ни одной.
//
// Свежесть: перед каждым поиском файлы перечитываются с диска — ищет оператор
// по свежей версии файла, а не по тому, что лежало в памяти в прошлый раз.

import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as XLSX from '@e965/xlsx';

import {
  docxXmlToText,
  matchExcelSheet,
  matchWordDocument,
  normalizeFileSearchQuery,
  type FileSearchExcelSheet,
  type FileSearchMatch,
  type FileSearchResult,
  type FileSearchSource,
  type FileSearchSourceKind,
  type FileSearchUnreadable,
} from '@matricarmz/shared';

import { raceWithAbort, SearchCancelledError } from './searchAbort.js';

/** Книга больше — читаем с потолка и говорим оператору, что прочитали не всё. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SHEET_ROWS = 20000;
const MAX_COLUMNS = 60;
/**
 * Потолок на ЧТЕНИЕ ОДНОГО файла.
 *
 * Это страховка от «нечитаемого» файла (зависшая сетевая папка, битый том), а
 * НЕ ограничение поиска: потолка на весь поиск здесь нет (промт КАРМАНА #166),
 * а отмена рвёт чтение немедленно.
 */
const READ_TIMEOUT_MS = 30000;

/** Ход поиска по файлам-источникам — наверх, в общий канал прогресса. */
export type FileSearchProgress = {
  /** Что читается прямо сейчас: имя файла. */
  current: string | null;
  /** Сколько файлов прочитано. */
  scanned: number;
  /** Сколько файлов выбрано оператором. */
  total: number;
  /** Найдено совпадений. */
  found: number;
};

export class SourceReadError extends Error {}

export const SEARCH_SOURCE_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.docx', '.txt', '.csv', '.tsv'];

export function classifySearchSourceKind(filePath: string): FileSearchSourceKind | null {
  const ext = extname(String(filePath ?? '')).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls') return 'excel';
  if (ext === '.docx') return 'word';
  if (ext === '.txt' || ext === '.csv' || ext === '.tsv') return 'text';
  return null;
}

/** Описание источника для списка в модуле: путь, имя, размер, время изменения. */
export async function describeSearchSource(filePath: string, nowMs = Date.now()): Promise<FileSearchSource> {
  const path = String(filePath ?? '').trim();
  if (!path) throw new SourceReadError('Пустой путь к файлу');
  const kind = classifySearchSourceKind(path);
  if (!kind) {
    throw new SourceReadError(
      `Файл «${basename(path)}» не поддерживается: нужны ${SEARCH_SOURCE_EXTENSIONS.join(', ')}`,
    );
  }
  let size: number | null = null;
  let modifiedAt: number | null = null;
  try {
    const st = await stat(path);
    size = st.size;
    modifiedAt = st.mtimeMs;
  } catch {
    // Файл недоступен уже сейчас — но это не повод отказывать в источнике:
    // оператор увидит сообщение при поиске и откроет файл заново.
  }
  return {
    id: sourceIdForPath(path),
    path,
    name: basename(path),
    kind,
    addedAt: nowMs,
    size,
    modifiedAt,
  };
}

/** Стабильный id источника: путь один и тот же — id тот же (перевыбор не плодит дубли). */
export function sourceIdForPath(path: string): string {
  const normalized = String(path ?? '').trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fs_${(hash >>> 0).toString(36)}`;
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
  if (size > MAX_FILE_BYTES) {
    throw new SourceReadError(
      `Файл слишком большой (${Math.round(size / (1024 * 1024))} МБ) — модуль читает файлы до ${Math.round(
        MAX_FILE_BYTES / (1024 * 1024),
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
    READ_TIMEOUT_MS,
    `Не удалось прочитать книгу за ${Math.round(READ_TIMEOUT_MS / 1000)} с — файл слишком большой или недоступен`,
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
      const lastRow = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS - 1);
      if (range.e.r > lastRow) truncated = true;
      for (let r = range.s.r; r <= lastRow; r += 1) {
        const values: string[] = [];
        const lastCol = Math.min(range.e.c, MAX_COLUMNS - 1);
        for (let c = range.s.c; c <= lastCol; c += 1) {
          values.push(xlsCellText(worksheet[XLSX.utils.encode_cell({ r, c })]));
        }
        while (values.length > 0 && values[values.length - 1] === '') values.pop();
        if (values.length === 0) continue;
        collected.push({ rowNumber: r + 1, values });
      }
    }
    if (truncated) {
      notes.push(`«${sheetName}»: прочитаны первые ${MAX_SHEET_ROWS} строк — остальные не просмотрены`);
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

async function readExcelSheets(
  path: string,
  notes: string[],
  signal?: AbortSignal,
): Promise<FileSearchExcelSheet[]> {
  await assertFileReadable(path, signal);
  if (extname(path).toLowerCase() === '.xls') return readLegacyXlsSheets(path, notes, signal);
  const workbook = new ExcelJS.Workbook();
  await withTimeout(
    workbook.xlsx.readFile(path),
    READ_TIMEOUT_MS,
    `Не удалось прочитать книгу за ${Math.round(READ_TIMEOUT_MS / 1000)} с — файл слишком большой или недоступен`,
    signal,
  );
  const sheets: FileSearchExcelSheet[] = [];
  workbook.eachSheet((worksheet) => {
    const collected: { rowNumber: number; values: string[] }[] = [];
    let truncated = false;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (collected.length >= MAX_SHEET_ROWS) {
        truncated = true;
        return;
      }
      const cellCount = Math.min(row.cellCount ?? 0, MAX_COLUMNS);
      const values: string[] = [];
      for (let c = 1; c <= cellCount; c += 1) values.push(excelCellText(row.getCell(c).value));
      while (values.length > 0 && values[values.length - 1] === '') values.pop();
      if (values.length === 0) return;
      collected.push({ rowNumber, values });
    });
    if (truncated) {
      notes.push(`«${worksheet.name}»: прочитаны первые ${MAX_SHEET_ROWS} строк — остальные не просмотрены`);
    }
    const { headers, dataRows } = pickHeaderAndRows(collected);
    sheets.push({ sheetName: worksheet.name, headers, rows: dataRows });
  });
  return sheets;
}

async function readWordParagraphs(path: string, signal?: AbortSignal): Promise<string[]> {
  await assertFileReadable(path, signal);
  const buffer = await withTimeout(
    readFile(path),
    READ_TIMEOUT_MS,
    `Не удалось прочитать документ за ${Math.round(READ_TIMEOUT_MS / 1000)} с — файл слишком большой или недоступен`,
    signal,
  );
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new SourceReadError('Файл .docx повреждён: внутри нет документа');
  const xml = await doc.async('string');
  const text = docxXmlToText(xml);
  return text.split('\n');
}

async function readTextLines(path: string, signal?: AbortSignal): Promise<string[]> {
  await assertFileReadable(path, signal);
  const buffer = await withTimeout(
    readFile(path),
    READ_TIMEOUT_MS,
    `Не удалось прочитать файл за ${Math.round(READ_TIMEOUT_MS / 1000)} с — файл слишком большой или недоступен`,
    signal,
  );
  return new TextDecoder('utf-8').decode(buffer).split(/\r?\n/);
}

async function searchInSource(
  source: FileSearchSource,
  query: string,
  notes: string[],
  signal?: AbortSignal,
): Promise<FileSearchMatch[]> {
  if (source.kind === 'excel') {
    const sheets = await readExcelSheets(source.path, notes, signal);
    const out: FileSearchMatch[] = [];
    for (const sheet of sheets) {
      out.push(
        ...matchExcelSheet({
          sourceId: source.id,
          sourceName: source.name,
          sheet,
          query,
        }),
      );
    }
    return out;
  }
  if (source.kind === 'word') {
    const paragraphs = await readWordParagraphs(source.path, signal);
    return matchWordDocument({ sourceId: source.id, sourceName: source.name, paragraphs, query });
  }
  const lines = await readTextLines(source.path, signal);
  return matchWordDocument({
    sourceId: source.id,
    sourceName: source.name,
    paragraphs: lines,
    query,
    kind: 'text',
  });
}

/**
 * Абзацы после найденного — по кнопке «показать строки ниже». Усечение не
 * молчаливое: оператор сам решает, показывать ли продолжение.
 */
export async function readSearchContext(
  source: FileSearchSource,
  paragraphIndex: number,
  count: number,
): Promise<string[]> {
  const take = Math.max(1, Math.min(50, Math.trunc(count) || 10));
  const from = Math.max(0, Math.trunc(paragraphIndex));
  if (source.kind === 'word') {
    const paragraphs = await readWordParagraphs(source.path);
    return paragraphs.slice(from, from + take);
  }
  if (source.kind === 'text') {
    const lines = await readTextLines(source.path);
    return lines.slice(from, from + take);
  }
  return [];
}

/**
 * Поиск по списку источников. Недоступный файл не роняет поиск: он уезжает в
 * `unreadable` с полным путём, остальные файлы ищутся дальше.
 *
 * Прогресс и отмена (промт КАРМАНА #166): оператор видит, какой файл читается
 * сейчас, сколько файлов прочитано и сколько найдено; кнопка «Отмена»
 * прерывает чтение (в том числе внутри файла) и отдаёт частичный результат.
 */
export async function searchFileSources(
  sources: readonly FileSearchSource[],
  rawQuery: string,
  options?: {
    /** Сигнал отмены: оператор нажал «Отмена». */
    signal?: AbortSignal;
    /** Ход поиска: текущий файл и счётчики. */
    onProgress?: (progress: FileSearchProgress) => void;
  },
): Promise<FileSearchResult> {
  const started = Date.now();
  const query = normalizeFileSearchQuery(rawQuery);
  const matches: FileSearchMatch[] = [];
  const unreadable: FileSearchUnreadable[] = [];
  const notes: string[] = [];
  const signal = options?.signal;
  const onProgress = options?.onProgress;
  let scannedFiles = 0;
  let cancelled = false;
  if (!query) {
    return { query, matches, unreadable, scannedFiles, durationMs: Date.now() - started, notes, cancelled: false };
  }
  for (const source of sources) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    onProgress?.({
      current: source.name,
      scanned: scannedFiles,
      total: sources.length,
      found: matches.length,
    });
    try {
      const found = await searchInSource(source, query, notes, signal);
      matches.push(...found);
      scannedFiles += 1;
    } catch (e) {
      if (e instanceof SearchCancelledError || signal?.aborted) {
        // Отмена — не поломка файла: результат частичный, поиск остановлен.
        cancelled = true;
        break;
      }
      unreadable.push({
        path: source.path,
        name: source.name,
        reason: e instanceof SourceReadError ? e.message : `Файл недоступен — откройте его заново (${String(e)})`,
      });
    }
    onProgress?.({
      current: source.name,
      scanned: scannedFiles,
      total: sources.length,
      found: matches.length,
    });
  }
  return { query, matches, unreadable, scannedFiles, durationMs: Date.now() - started, notes, cancelled };
}
