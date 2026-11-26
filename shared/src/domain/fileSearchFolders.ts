// Домен поиска по папкам (промт КАРМАНА #88, план #89).
//
// Модуль «Поиск по файлам» умел искать по СОДЕРЖИМОМУ выбранных файлов.
// Владелец попросил ещё один режим: оператор добавляет папки с фотографиями
// двигателей и ищет по НАЗВАНИЮ — по названию папки («Э06АТ0889») и по
// названию файла. Найденная папка показывается вместе со своим содержимым —
// крупными превью картинок, — из которых можно отметить несколько и отправить
// на печать.
//
// Здесь — только чистые правила: что считать совпадением, как называть
// совпадение и как сгруппировать картинки по найденным папкам. Файловая
// система — в main (`main/services/fileSearchFolderService.ts`).

import type { FileSearchUnreadable } from './fileSearch.js';

/** Источник-папка: одна выбранная оператором папка с фотографиями. */
export type FileSearchFolderSource = {
  id: string;
  /** Полный путь к папке: оператор видит его, когда папка стала недоступна. */
  path: string;
  /** Имя папки (последний сегмент пути). */
  name: string;
  addedAt: number;
};

/**
 * Что именно совпало с запросом.
 *
 * `folder` — совпало название папки; `file` — совпало название файла.
 * Различие оператору важно: папка найдена целиком (показываем её содержимое),
 * а файл — это отдельная находка.
 */
export type FileSearchFolderMatchKind = 'folder' | 'file';

/**
 * Область совпадения при поиске по папкам.
 *
 * `any` — как было: совпадение и по названию папки, и по названию файла.
 * `folder` — только по названию ПАПКИ: режим «Фото двигателя». Находка тогда —
 * папка целиком (со всеми её фотографиями), а не отдельный файл, имя которого
 * случайно подошло.
 */
export type FileSearchFolderSearchScope = 'any' | 'folder';

/** Допустимые области — renderer и main читают один список. */
export const FILE_SEARCH_FOLDER_SEARCH_SCOPES: readonly FileSearchFolderSearchScope[] = ['any', 'folder'];

/**
 * Область из аргументов канала: неизвестное значение — «any» (старое поведение).
 *
 * Мусор в аргументах не должен молча менять смысл поиска: не поняли — ищем как
 * раньше, по названию папки и по названию файла.
 */
export function normalizeFileSearchFolderScope(raw: unknown): FileSearchFolderSearchScope {
  return raw === 'folder' ? 'folder' : 'any';
}

/** Допускает ли область находку по названию ФАЙЛА. */
export function folderScopeAllowsFileMatches(scope: FileSearchFolderSearchScope): boolean {
  return scope !== 'folder';
}

/** Одно найденное совпадение: папка или файл. */
export type FileSearchFolderMatch = {
  /** Ключ совпадения — по нему картинки привязываются к своей находке. */
  key: string;
  sourceId: string;
  sourceName: string;
  /** Путь относительно корня источника (без имени источника). */
  relativePath: string;
  /** Имя папки или файла. */
  name: string;
  matchedBy: FileSearchFolderMatchKind;
  /** Сколько картинок в этой находке (для папки — во всём её содержимом). */
  imageCount: number;
};

/**
 * Картинка из найденной папки.
 *
 * `id` — непрозрачный идентификатор, который выдаёт главный процесс: renderer
 * не знает и не может подсунуть путь на диске — только id, который main сам
 * выдал при поиске. Это тот же класс защиты, что и `consumeIssuedPath`.
 */
export type FileSearchFolderImage = {
  id: string;
  /** Ключ совпадения, в котором найдена картинка. */
  matchKey: string;
  name: string;
  /** Путь относительно корня источника — показываем оператору, где лежит. */
  relativePath: string;
  size: number | null;
};

/** Результат поиска по папкам. */
export type FileSearchFolderResult = {
  query: string;
  matches: FileSearchFolderMatch[];
  images: FileSearchFolderImage[];
  unreadable: FileSearchUnreadable[];
  /** Замечания к обходу: «достигнут потолок вложенности», «часть папок не прочитана». */
  notes: string[];
  scannedFolders: number;
  durationMs: number;
};

/** Расширения, которые показываем превью и печатаем как картинки. */
export const FILE_SEARCH_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'];

export function fileSearchImageExtension(name: string): string {
  const dot = String(name ?? '').toLowerCase().lastIndexOf('.');
  return dot < 0 ? '' : String(name ?? '').toLowerCase().slice(dot + 1);
}

/** Картинка ли это — по расширению. */
export function isFileSearchImage(name: string): boolean {
  return FILE_SEARCH_IMAGE_EXTENSIONS.includes(fileSearchImageExtension(name));
}

/**
 * Совпадение по названию — вхождение подстроки без учёта регистра.
 *
 * Тот же принцип, что у поиска по содержимому файлов: ищем «41/26» и находим
 * «Э06АТ0889_41-26» — но здесь сравниваются ИМЕНА, а не содержимое.
 */
export function folderNameMatches(name: string, query: string): boolean {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return false;
  return String(name ?? '').toLowerCase().includes(q);
}

/**
 * Какие имена из списка совпадают с запросом — с сохранением порядка.
 *
 * Чистая функция: на неё опирается обход папок в main и тесты домена.
 */
export function matchFolderNames(names: readonly string[], query: string): string[] {
  if (!String(query ?? '').trim()) return [];
  return names.filter((name) => folderNameMatches(name, query));
}

/**
 * Ключ совпадения: источник + относительный путь + вид.
 *
 * Один и тот же файл в разных папках — разные находки, а перезапуск поиска
 * даёт те же ключи (значит, отметки галочек не теряются при повторном поиске).
 */
export function folderMatchKey(args: {
  sourceId: string;
  relativePath: string;
  matchedBy: FileSearchFolderMatchKind;
}): string {
  return `${args.sourceId}|${args.matchedBy}|${args.relativePath}`;
}

/**
 * Картинки по находкам: ключ совпадения → картинки.
 *
 * Страница показывает находки списком, а внутри каждой — её картинки.
 */
export function groupFolderImagesByMatch(
  images: readonly FileSearchFolderImage[],
): Record<string, FileSearchFolderImage[]> {
  const out: Record<string, FileSearchFolderImage[]> = {};
  for (const image of images) {
    const list = out[image.matchKey] ?? [];
    list.push(image);
    out[image.matchKey] = list;
  }
  return out;
}
