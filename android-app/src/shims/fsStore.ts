// Общее хранилище «файлов» планшета: записи в localStorage WebView под префиксом
// пути. Оба шима (node:fs и node:fs/promises) читают и пишут ОДНИ И ТЕ ЖЕ ключи:
// иначе `existsSync`/`stat` врали бы о файле, который `readFile` честно читает
// (план #114, шаг 30: «файл выгрузки» на планшете — запись в localStorage, и он
// не переживает очистку данных приложения).
export const FS_PREFIX = 'matricarmz.fs:';

export function fsStore(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function fsKey(path: string): string {
  return FS_PREFIX + path;
}

function fsMtimeKey(path: string): string {
  return fsKey(path) + '#mtime';
}

export function fsRead(path: string): string | null {
  return fsStore()?.getItem(fsKey(path)) ?? null;
}

export function fsWrite(path: string, data: string): void {
  const s = fsStore();
  if (!s) return;
  s.setItem(fsKey(path), data);
  // Метка времени — рядом с содержимым: по ней `stat` отличает одну выгрузку от
  // другой того же размера (кеш разбора «файла» выгрузки).
  s.setItem(fsMtimeKey(path), String(Date.now()));
}

export function fsRemove(path: string): boolean {
  const s = fsStore();
  if (!s) return false;
  const existed = s.getItem(fsKey(path)) != null;
  s.removeItem(fsKey(path));
  s.removeItem(fsMtimeKey(path));
  return existed;
}

export function fsStat(path: string): { size: number; mtimeMs: number } | null {
  const s = fsStore();
  if (!s) return null;
  const value = s.getItem(fsKey(path));
  if (value == null) return null;
  const mtime = Number(s.getItem(fsMtimeKey(path)) ?? 0);
  return { size: value.length, mtimeMs: Number.isFinite(mtime) ? mtime : 0 };
}
