// Чтение файлов оператора для модуля «Поиск по файлам» (промт КАРМАНА #32).
//
// Файловая система — здесь, в main: renderer не читает файлы и не держит
// «примитив прочитать любой файл с диска» (прецедент — `filesReadPastableText`).
// Модуль ТОЛЬКО ЧИТАЕТ: функции записи в выбранные файлы нет ни одной.
//
// Свежесть: перед каждым поиском файлы перечитываются с диска — ищет оператор
// по свежей версии файла, а не по тому, что лежало в памяти в прошлый раз.

import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import {
  matchExcelSheet,
  matchWordDocument,
  normalizeFileSearchQuery,
  type FileSearchMatch,
  type FileSearchResult,
  type FileSearchSource,
  type FileSearchSourceKind,
  type FileSearchUnreadable,
} from '@matricarmz/shared';

import {
  readExcelSheets,
  readTextLines,
  readWordParagraphs,
  SourceReadError,
} from './fileContentReader.js';
import { SearchCancelledError } from './searchAbort.js';

export { SourceReadError };

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

// Чтение книг, документов и текста живёт в общем модуле `fileContentReader.ts`:
// и поиск по файлам, и действие агента (промт КАРМАНА #176, разрез 2) зовут его —
// второй ридер означал бы две копии правила чтения.

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
