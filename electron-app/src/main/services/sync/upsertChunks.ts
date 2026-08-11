// Байтовое чанкование bulk-upsert'а пулла. Причина существования — Android:
// Capacitor-мост парсит КАЖДЫЙ JS→native вызов как один JSON-документ в Java-куче
// (лимит 256 МБ), и upsert на 2000 жирных строк убивает процесс OOM'ом раньше,
// чем Android-SQLite успеет ответить «too many variables» (GOTCHAS M74).
// Десктоп лимитов не меняет: better-sqlite3 работает в одном процессе без
// сериализации, там действует только кап bind-параметров.
export type SyncSqlLimits = {
  maxBindParams: number;
  /** null = байтовый кап выключен (десктоп). */
  maxChunkBytes: number | null;
};

// better-sqlite3 bundles modern SQLite (SQLITE_MAX_VARIABLE_NUMBER=32766 since 3.32).
export const DESKTOP_SYNC_SQL_LIMITS: SyncSqlLimits = { maxBindParams: 32000, maxChunkBytes: null };

let currentLimits: SyncSqlLimits = DESKTOP_SYNC_SQL_LIMITS;

/** Платформенная обвязка (android wireSyncForAndroid) вызывает до первого runSync. */
export function setSyncSqlLimits(limits: Partial<SyncSqlLimits>): void {
  currentLimits = { ...DESKTOP_SYNC_SQL_LIMITS, ...limits };
}

export function getSyncSqlLimits(): SyncSqlLimits {
  return currentLimits;
}

// Оценка вклада строки в JSON bridge-сообщения: длины строк + накладные на ключи
// и значения. Кириллица в UTF-8 в ~2 раза тяжелее .length — кап выбирать с запасом.
export function estimateRowBytes(row: Record<string, unknown>): number {
  let total = 64;
  for (const key of Object.keys(row)) {
    total += key.length + 8;
    const v = row[key];
    if (typeof v === 'string') total += v.length + 8;
    else total += 16;
  }
  return total;
}

/**
 * Конец следующего чанка (exclusive) от `start`: не больше maxRows строк и,
 * при включённом байтовом капе, не тяжелее maxChunkBytes. Первая строка входит
 * всегда — иначе строка тяжелее капа зациклила бы пулл.
 */
export function nextUpsertChunkEnd(
  rows: Array<Record<string, unknown>>,
  start: number,
  maxRows: number,
  maxChunkBytes: number | null,
): number {
  const hardEnd = Math.min(rows.length, start + Math.max(1, maxRows));
  if (maxChunkBytes == null) return hardEnd;
  let end = start + 1;
  let bytes = estimateRowBytes(rows[start] ?? {});
  while (end < hardEnd) {
    bytes += estimateRowBytes(rows[end] ?? {});
    if (bytes > maxChunkBytes) break;
    end += 1;
  }
  return end;
}
