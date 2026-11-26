// Поиск по папкам для модуля «Поиск по файлам» (промт КАРМАНА #88, план #89).
//
// Файловую систему читает главный процесс: renderer не читает диск и не
// держит «примитив прочитать любой файл с диска» (прецедент —
// `filesReadPastableText`, сторож `FileSearchPage.guard.test.ts`).
//
// Главное отличие от поиска по файлам — ЗДЕСЬ ИЩЕТСЯ ПО НАЗВАНИЮ. Оператор
// добавляет папки с фотографиями двигателей, вводит номер двигателя и получает
// папки, в названии которых он есть («Э06АТ0889»), вместе с их содержимым.
//
// Модуль ТОЛЬКО ЧИТАЕТ: функции записи в выбранные папки или файлы нет ни одной.
//
// ПОТОЛКИ. Потолки по КОЛИЧЕСТВУ (глубина вложенности, число папок, число
// файлов, число находок) обязательны: папок и картинок может быть много.
//
// Общего потолка по ВРЕМЕНИ на весь поиск больше нет (промт КАРМАНА #166):
// раньше обход рвался на 30 секундах, и оператор получал «Поиск остановлен по
// времени — часть папок не просмотрена». Теперь поиск идёт, пока не кончится
// или пока оператор не отменит, а полоса прогресса показывает, ЧТО именно
// перебирается. Остался потолок на ОДНУ папку (`FOLDER_READ_TIMEOUT_MS`):
// «зависшая» сетевая папка не должна держать остальные папки — мы её
// пропускаем и идём дальше.

import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join, sep } from 'node:path';

import {
  fileSearchImageExtension,
  folderMatchKey,
  folderScopeAllowsFileMatches,
  isFileSearchImage,
  normalizeFileSearchQuery,
  normalizeFileSearchFolderScope,
  type FileSearchFolderImage,
  type FileSearchFolderMatch,
  type FileSearchFolderResult,
  type FileSearchFolderSearchScope,
  type FileSearchFolderSource,
  type FileSearchUnreadable,
} from '@matricarmz/shared';

import { SearchCancelledError, raceWithAbort } from './searchAbort.js';

/** Глубина вложенности: «папка двигателей → подпапка → фото» — этого хватает. */
export const MAX_FOLDER_DEPTH = 3;
/** Сколько папок обходим за один поиск. */
export const MAX_SCANNED_FOLDERS = 5000;
/** Сколько файлов перебираем за один поиск. */
export const MAX_SCANNED_FILES = 20000;
/** Сколько находок (папок и файлов) показываем оператору. */
export const MAX_FOLDER_MATCHES = 200;
/** Сколько картинок показываем в одной находке. */
export const MAX_IMAGES_PER_MATCH = 200;
/**
 * Потолок ожидания на ОДНУ папку (не на весь поиск).
 *
 * Сетевая папка не должна держать поиск вечно — но ограничивать ею весь обход
 * нельзя: оператор сам решает, когда остановиться (кнопка «Отмена»).
 */
export const FOLDER_READ_TIMEOUT_MS = 30000;
/** Потолок на одну картинку в превью (гигабайтная фотография — не наш случай). */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** Сколько выданных id картинок держим в реестре. */
export const MAX_IMAGE_REGISTRY = 5000;

export class FolderScanError extends Error {}

/** Папка не ответила за отведённое время — пропускаем её и идём дальше. */
class FolderReadTimeoutError extends Error {}

/** Ход поиска по папкам — наверх, в общий канал прогресса. */
export type FolderSearchProgress = {
  /** Что читается прямо сейчас: имя папки. */
  current: string | null;
  /** Сколько папок-источников просмотрено. */
  scanned: number;
  /** Сколько папок-источников выбрано оператором. */
  total: number;
  /** Найдено находок. */
  found: number;
  /** Всего папок в дереве (с подпапками) — растёт по ходу обхода. */
  foldersInTree: number;
};

/** Описание папки-источника для списка в модуле. */
export async function describeFolderSource(path: string, nowMs = Date.now()): Promise<FileSearchFolderSource> {
  const clean = String(path ?? '').trim();
  if (!clean) throw new FolderScanError('Пустой путь к папке');
  let isDir = false;
  try {
    const st = await stat(clean);
    isDir = st.isDirectory();
  } catch {
    // Папка недоступна уже сейчас — но это не повод отказывать в источнике:
    // оператор увидит сообщение при поиске и выберет папку заново.
  }
  if (!isDir) throw new FolderScanError(`«${basename(clean)}» — это не папка`);
  return {
    id: folderSourceIdForPath(clean),
    path: clean,
    name: basename(clean) || clean,
    addedAt: nowMs,
  };
}

/** Стабильный id источника: та же папка — тот же id (перевыбор не плодит дубли). */
export function folderSourceIdForPath(path: string): string {
  const normalized = String(path ?? '').trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fsf_${(hash >>> 0).toString(36)}`;
}

/**
 * Реестр выданных id картинок: id → путь на диске.
 *
 * Renderer получает только id и никогда — путь. Так превью и печать не дают
 * прочитать или напечатать произвольный файл: main знает только те картинки,
 * которые сам нашёл в папках, выбранных оператором. Тот же класс защиты, что у
 * `consumeIssuedPath` для загрузки файлов.
 */
const imageRegistry = new Map<string, { path: string; name: string }>();

function registerImage(path: string, name: string): string {
  const id = `fsimg_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  imageRegistry.set(id, { path, name });
  // Реестр не растёт бесконечно: старые id вытесняются.
  while (imageRegistry.size > MAX_IMAGE_REGISTRY) {
    const oldest = imageRegistry.keys().next();
    if (oldest.done) break;
    imageRegistry.delete(oldest.value);
  }
  return id;
}

/** Путь картинки по выданному id. null — такого id main не выдавал. */
export function resolveImagePath(id: string): { path: string; name: string } | null {
  return imageRegistry.get(String(id ?? '').trim()) ?? null;
}

/** Забыть выданные id (после теста). */
export function clearImageRegistry(): void {
  imageRegistry.clear();
}

type ScannedFile = {
  relativePath: string;
  name: string;
  absolutePath: string;
  size: number | null;
  modifiedAt: number | null;
  isImage: boolean;
};

type ScannedFolder = {
  relativePath: string;
  name: string;
  absolutePath: string;
};

function joinRelative(relativePath: string, name: string): string {
  return relativePath ? `${relativePath}${sep}${name}` : name;
}

/**
 * Чтение одной папки с потолком ожидания и отменой.
 *
 * Потолок — на ОДНУ папку: «зависшая» сетевая папка уходит в `unreadable`, а
 * поиск идёт дальше. Отмена рвёт ожидание немедленно.
 */
async function readFolderEntries(dirPath: string, signal?: AbortSignal): Promise<Dirent[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FolderReadTimeoutError()), FOLDER_READ_TIMEOUT_MS);
  });
  try {
    return await raceWithAbort(Promise.race([readdir(dirPath, { withFileTypes: true }), timeout]), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Размер и время файла — тоже с потолком: сеть умеет зависать и на stat. */
async function statWithTimeout(path: string, signal?: AbortSignal): Promise<{ size: number; mtimeMs: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FolderReadTimeoutError()), FOLDER_READ_TIMEOUT_MS);
  });
  try {
    return await raceWithAbort(Promise.race([stat(path), timeout]), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Поиск по названиям в выбранных папках.
 *
 * Находка — папка, в названии которой есть запрос, либо файл с таким
 * названием. Для папки показываем её содержимое (картинки внутри), для файла —
 * сам файл.
 *
 * Область поиска (`scope`) решает, что считается находкой:
 *  * `any` (по умолчанию) — как было: и папка, и отдельный файл;
 *  * `folder` — режим «Фото двигателя»: совпадение ТОЛЬКО по названию папки,
 *    находка — папка целиком со всеми её фотографиями. Отдельный файл, имя
 *    которого случайно подошло, в этом режиме находкой не является.
 *
 * Совпадения находятся ВО ВРЕМЯ обхода, а не после: оператор видит найденное
 * сразу, а счётчик «найдено» в полосе прогресса не расходится с результатом.
 *
 * Отмена (`signal`) останавливает обход на самом деле: накопленное отдаётся
 * частичным результатом, а `cancelled` в результате говорит оператору, что
 * поиск прекращён по его команде.
 */
export async function searchFolderSources(
  sources: readonly FileSearchFolderSource[],
  rawQuery: string,
  options?: {
    scope?: FileSearchFolderSearchScope;
    /** Сигнал отмены: оператор нажал «Отмена». */
    signal?: AbortSignal;
    /** Ход поиска: текущая папка и счётчики. */
    onProgress?: (progress: FolderSearchProgress) => void;
  },
): Promise<FileSearchFolderResult> {
  const started = Date.now();
  const query = normalizeFileSearchQuery(rawQuery);
  const scope = normalizeFileSearchFolderScope(options?.scope);
  const matches: FileSearchFolderMatch[] = [];
  const images: FileSearchFolderImage[] = [];
  const unreadable: FileSearchUnreadable[] = [];
  const notes: string[] = [];
  const signal = options?.signal;
  const onProgress = options?.onProgress;
  const lowerQuery = query.toLowerCase();
  const allowFileMatches = folderScopeAllowsFileMatches(scope);
  /** Всего папок в дереве (подпапки + корень каждого источника). */
  let scannedFolders = 0;
  /** Сколько папок-источников обойдено. */
  let scannedSources = 0;
  let cancelled = false;

  if (!query) {
    return {
      query,
      matches,
      images,
      unreadable,
      notes,
      scannedFolders,
      durationMs: Date.now() - started,
      cancelled: false,
    };
  }

  const report = (current: string | null) => {
    if (!onProgress) return;
    onProgress({
      current,
      scanned: scannedSources,
      total: sources.length,
      found: matches.length,
      foldersInTree: scannedFolders,
    });
  };

  for (const source of sources) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }

    /** Совпавшие папки источника: относительный путь → находка. */
    const matchedByPath = new Map<string, FileSearchFolderMatch>();
    /** Сколько картинок ВСЕГО внутри совпавшей папки (для замечания «первые N из M»). */
    const imageTotals = new Map<string, number>();
    /** Сколько картинок уже зарегистрировано по совпавшей папке. */
    const imageShown = new Map<string, number>();
    let hitDepthLimit = false;
    let hitFolderLimit = false;
    let hitFileLimit = false;
    let sourceFolders = 0;
    let sourceFiles = 0;

    /** Находка по названию папки — если имя подходит. */
    const addFolderMatch = (folder: ScannedFolder): void => {
      if (!folder.name.toLowerCase().includes(lowerQuery)) return;
      if (matches.length >= MAX_FOLDER_MATCHES) {
        notes.push(`Находок больше ${MAX_FOLDER_MATCHES} — показываем первые`);
        return;
      }
      const key = folderMatchKey({ sourceId: source.id, relativePath: folder.relativePath, matchedBy: 'folder' });
      const match: FileSearchFolderMatch = {
        key,
        sourceId: source.id,
        sourceName: source.name,
        relativePath: folder.relativePath,
        name: folder.name,
        matchedBy: 'folder',
        imageCount: 0,
      };
      matches.push(match);
      matchedByPath.set(folder.relativePath, match);
      imageTotals.set(folder.relativePath, 0);
      imageShown.set(folder.relativePath, 0);
    };

    /** Картинка попадает в каждую совпавшую папку, внутри которой она лежит. */
    const attachImage = (file: ScannedFile): void => {
      for (const [folderPath, match] of matchedByPath) {
        const prefix = folderPath ? folderPath + sep : '';
        if (!file.relativePath.startsWith(prefix)) continue;
        imageTotals.set(folderPath, (imageTotals.get(folderPath) ?? 0) + 1);
        const shown = imageShown.get(folderPath) ?? 0;
        if (shown >= MAX_IMAGES_PER_MATCH) continue;
        imageShown.set(folderPath, shown + 1);
        match.imageCount = shown + 1;
        images.push({
          id: registerImage(file.absolutePath, file.name),
          matchKey: match.key,
          name: file.name,
          relativePath: file.relativePath,
          size: file.size,
        });
      }
    };

    /** Находка по названию файла — если имя подходит и файл не внутри найденной папки. */
    const addFileMatch = (file: ScannedFile): void => {
      if (!allowFileMatches) return;
      if (!file.name.toLowerCase().includes(lowerQuery)) return;
      if (matches.length >= MAX_FOLDER_MATCHES) {
        notes.push(`Находок больше ${MAX_FOLDER_MATCHES} — показываем первые`);
        return;
      }
      for (const folderPath of matchedByPath.keys()) {
        const inside = folderPath ? file.relativePath.startsWith(folderPath + sep) : true;
        if (inside) return;
      }
      const key = folderMatchKey({ sourceId: source.id, relativePath: file.relativePath, matchedBy: 'file' });
      matches.push({
        key,
        sourceId: source.id,
        sourceName: source.name,
        relativePath: file.relativePath,
        name: file.name,
        matchedBy: 'file',
        imageCount: file.isImage ? 1 : 0,
      });
      if (file.isImage) {
        images.push({
          id: registerImage(file.absolutePath, file.name),
          matchKey: key,
          name: file.name,
          relativePath: file.relativePath,
          size: file.size,
        });
      }
    };

    // Сама папка-источник — тоже кандидат на совпадение: оператор мог добавить
    // сразу папку двигателя («Э06АТ0889») — тогда по её названию мы и обязаны её
    // найти, вместе с содержимым.
    addFolderMatch({ relativePath: '', name: source.name, absolutePath: source.path });

    const walk = async (dirPath: string, relativePath: string, level: number): Promise<void> => {
      if (signal?.aborted) {
        cancelled = true;
        return;
      }
      const dirName = basename(dirPath) || source.name;
      report(dirName);
      let entries: Dirent[];
      try {
        entries = await readFolderEntries(dirPath, signal);
      } catch (e) {
        if (signal?.aborted || e instanceof SearchCancelledError) {
          cancelled = true;
          return;
        }
        unreadable.push({
          path: dirPath,
          name: dirName,
          reason:
            e instanceof FolderReadTimeoutError
              ? `Папка не ответила за ${Math.round(FOLDER_READ_TIMEOUT_MS / 1000)} с — пропущена`
              : 'Папка недоступна — выберите её заново',
        });
        return;
      }
      for (const entry of entries) {
        if (signal?.aborted) {
          cancelled = true;
          return;
        }
        const name = entry.name;
        const childPath = join(dirPath, name);
        const childRelative = joinRelative(relativePath, name);
        if (entry.isDirectory()) {
          if (sourceFolders >= MAX_SCANNED_FOLDERS) {
            hitFolderLimit = true;
            continue;
          }
          if (level + 1 > MAX_FOLDER_DEPTH) {
            hitDepthLimit = true;
            continue;
          }
          sourceFolders += 1;
          scannedFolders += 1;
          addFolderMatch({ relativePath: childRelative, name, absolutePath: childPath });
          await walk(childPath, childRelative, level + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (sourceFiles >= MAX_SCANNED_FILES) {
          hitFileLimit = true;
          return;
        }
        sourceFiles += 1;
        let size: number | null = null;
        let modifiedAt: number | null = null;
        try {
          const st = await statWithTimeout(childPath, signal);
          size = st.size;
          modifiedAt = st.mtimeMs;
        } catch (e) {
          if (signal?.aborted || e instanceof SearchCancelledError) {
            cancelled = true;
            return;
          }
          // Файл исчез между чтением папки и stat — пропускаем: поиск идёт дальше.
        }
        const file: ScannedFile = {
          relativePath: childRelative,
          name,
          absolutePath: childPath,
          size,
          modifiedAt,
          isImage: isFileSearchImage(name),
        };
        if (file.isImage) attachImage(file);
        addFileMatch(file);
      }
    };

    try {
      await walk(source.path, '', 0);
    } catch (e) {
      if (signal?.aborted || e instanceof SearchCancelledError) {
        cancelled = true;
      } else {
        unreadable.push({
          path: source.path,
          name: source.name,
          reason: e instanceof FolderScanError ? e.message : 'Папка недоступна — выберите её заново',
        });
      }
    }

    // Корень источника — тоже просмотренная папка (как было).
    scannedFolders += 1;
    scannedSources += 1;

    for (const [folderPath, match] of matchedByPath) {
      const total = imageTotals.get(folderPath) ?? 0;
      const shown = imageShown.get(folderPath) ?? 0;
      if (total > shown) {
        notes.push(`«${match.name}»: показаны первые ${shown} картинок из ${total}`);
      }
    }

    if (hitDepthLimit) {
      notes.push(`Глубже ${MAX_FOLDER_DEPTH} уровней вложенности не смотрели — часть папок пропущена`);
    }
    if (hitFolderLimit) {
      notes.push(`Просмотрено не больше ${MAX_SCANNED_FOLDERS} папок — остальные пропущены`);
    }
    if (hitFileLimit) {
      notes.push(`Просмотрено не больше ${MAX_SCANNED_FILES} файлов — остальные пропущены`);
    }

    report(null);
    if (cancelled) break;
  }

  return {
    query,
    matches,
    images,
    unreadable,
    notes: [...new Set(notes)],
    scannedFolders,
    durationMs: Date.now() - started,
    cancelled,
  };
}

/** Расширение файла в нижнем регистре — для mime-типа превью. */
export function imageExtensionOf(path: string): string {
  return fileSearchImageExtension(path);
}
