// Что лежит на машине в файлах-выгрузках `pending-export-*.json`.
//
// Файл появляется, когда клиенту пришлось пересобрать локальную базу (расхождение схемы
// с сервером, прерванная полная загрузка): неотправленные строки выгружаются в JSON
// рядом с базой, потому что сама база сейчас будет удалена. Дальше файл живёт своей
// жизнью — после успешного реплея он удаляется, а если реплей прошёл частично, то
// остаётся, и данные, которых нет на сервере, лежат на диске тихо.
//
// Отсюда и модуль: он читает остатки и отдаёт сводку для баннера оператора. Значения
// строк наружу не идут — только имена файлов, таблицы и количества (D-041).
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PendingExportFile, PendingExportSummary, PendingExportTableStat } from '@matricarmz/shared';

/** Префикс и расширение файла-выгрузки. Живут здесь, потому что знание о них нужно и
 * писателю выгрузки (`syncService`), и читателю остатков (этот модуль). */
export const PENDING_EXPORT_PREFIX = 'pending-export-';
export const PENDING_EXPORT_SUFFIX = '.json';

/**
 * Список выгрузок, которые реплей не смог вернуть в базу. Их **нельзя чистить**: это
 * неотправленные данные оператора, которые больше нигде не лежат.
 */
const KEPT_STATE_FILE = 'pending-export-kept.json';

type ParsedExport = {
  rows: number;
  exportedAt: number | null;
  reason: string | null;
  byTable: PendingExportTableStat[];
};

/**
 * Разбор файла кэшируется по (имя, размер, mtime): файлы большие (в них лежат целые
 * строки), а статус синка интерфейс спрашивает постоянно — перечитывать их каждый раз
 * нельзя.
 */
const parseCache = new Map<string, { key: string; parsed: ParsedExport }>();
const PARSE_CACHE_MAX = 16;

/** Сбросить кэш разбора — для тестов и для сброса состояния. */
export function resetPendingExportCache(): void {
  parseCache.clear();
}

function emptySummary(): PendingExportSummary {
  return { files: [], rows: 0, byTable: [], oldestExportedAt: null, reason: null };
}

function toNumber(value: unknown): number | null {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts;
}

async function parseExportFile(path: string, name: string): Promise<ParsedExport> {
  let statKey = '';
  try {
    const info = await stat(path);
    statKey = `${info.size}:${info.mtimeMs}`;
  } catch {
    statKey = 'missing';
  }
  const cached = parseCache.get(name);
  if (cached && cached.key === statKey) return cached.parsed;

  let parsed: ParsedExport = { rows: 0, exportedAt: null, reason: null, byTable: [] };
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      exportedAt?: unknown;
      reason?: unknown;
      packs?: Array<{ table?: unknown; rows?: unknown }>;
    } | null;
    const packs = Array.isArray(raw?.packs) ? raw.packs : [];
    const byTable = new Map<string, number>();
    let rows = 0;
    for (const pack of packs) {
      const table = String(pack?.table ?? '').trim();
      const packRows = Array.isArray(pack?.rows) ? pack.rows : [];
      if (!table || packRows.length === 0) continue;
      rows += packRows.length;
      byTable.set(table, (byTable.get(table) ?? 0) + packRows.length);
    }
    parsed = {
      rows,
      exportedAt: toNumber(raw?.exportedAt),
      reason: String(raw?.reason ?? '').trim() || null,
      byTable: [...byTable.entries()].map(([table, n]) => ({ table, n })),
    };
  } catch {
    // Файл не читается — данные в нём могут быть, а объём мы не знаем. Оставляем файл
    // в списке: оператор всё равно должен отдать его администратору.
    parsed = { rows: 0, exportedAt: null, reason: null, byTable: [] };
  }

  if (parseCache.size >= PARSE_CACHE_MAX) {
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey !== undefined) parseCache.delete(oldestKey);
  }
  parseCache.set(name, { key: statKey, parsed });
  return parsed;
}

/**
 * Выгрузки, которые реплей не смог вернуть в базу. Их нельзя удалять чисткой: это
 * неотправленные данные оператора, которых больше нигде нет.
 */
export async function readKeptExportFiles(dir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(join(dir, KEPT_STATE_FILE), 'utf8')) as { kept?: unknown };
    const kept = Array.isArray(raw?.kept) ? raw.kept : [];
    return kept.map((n) => String(n)).filter((n) => n.startsWith(PENDING_EXPORT_PREFIX));
  } catch {
    return [];
  }
}

async function writeKeptExportFiles(dir: string, names: string[]): Promise<void> {
  const unique = [...new Set(names)].filter((n) => n.startsWith(PENDING_EXPORT_PREFIX));
  try {
    await writeFile(join(dir, KEPT_STATE_FILE), JSON.stringify({ kept: unique }), 'utf8');
  } catch {
    // Не записался список — чистка останется как была (по числу файлов), но данные не
    // пропадут молча только если повезёт; поэтому пишем в лог на стороне вызывающего.
  }
}

/** Отметить выгрузку как «реплей не прошёл» — её нельзя будет удалить чисткой. */
export async function markExportFileKept(dir: string, name: string): Promise<void> {
  const kept = await readKeptExportFiles(dir);
  if (kept.includes(name)) return;
  await writeKeptExportFiles(dir, [...kept, name]);
}

/** Снять отметку — файл ушёл (реплей прошёл и файл удалён). */
export async function unmarkExportFileKept(dir: string, name: string): Promise<void> {
  const kept = await readKeptExportFiles(dir);
  if (!kept.includes(name)) return;
  await writeKeptExportFiles(dir, kept.filter((n) => n !== name));
}

/**
 * Сводка по файлам-выгрузкам, лежащим в папке данных программы. Пустая сводка — значит
 * неотправленных данных вне базы нет.
 */
export async function readPendingExportState(userDataPath: string): Promise<PendingExportSummary> {
  const dir = String(userDataPath ?? '').trim();
  if (!dir) return emptySummary();

  let names: string[];
  try {
    names = (await readdir(dir)).filter(
      (n) => n.startsWith(PENDING_EXPORT_PREFIX) && n.endsWith(PENDING_EXPORT_SUFFIX),
    );
  } catch {
    return emptySummary();
  }
  if (names.length === 0) return emptySummary();

  names.sort();
  const files: PendingExportFile[] = [];
  const byTable = new Map<string, number>();
  let rows = 0;
  let oldestExportedAt: number | null = null;
  let reason: string | null = null;

  for (const name of names) {
    const parsed = await parseExportFile(join(dir, name), name);
    files.push({ name, rows: parsed.rows, exportedAt: parsed.exportedAt, reason: parsed.reason });
    rows += parsed.rows;
    for (const statRow of parsed.byTable) byTable.set(statRow.table, (byTable.get(statRow.table) ?? 0) + statRow.n);
    if (parsed.exportedAt != null && (oldestExportedAt == null || parsed.exportedAt < oldestExportedAt)) {
      oldestExportedAt = parsed.exportedAt;
    }
    // Причина берётся у самой свежей выгрузки — она и есть последнее, что случилось.
    if (parsed.reason) reason = parsed.reason;
  }

  return {
    files,
    rows,
    byTable: [...byTable.entries()].map(([table, n]) => ({ table, n })),
    oldestExportedAt,
    reason,
  };
}
