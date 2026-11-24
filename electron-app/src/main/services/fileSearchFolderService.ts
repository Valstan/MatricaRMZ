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
// Потолки обязательны: папок и картинок может быть много, а сеть бывает
// медленной — при превышении оператор получает замечание, а не зависание.

import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join, sep } from 'node:path';

import {
  fileSearchImageExtension,
  folderMatchKey,
  isFileSearchImage,
  normalizeFileSearchQuery,
  type FileSearchFolderImage,
  type FileSearchFolderMatch,
  type FileSearchFolderResult,
  type FileSearchFolderSource,
  type FileSearchUnreadable,
} from '@matricarmz/shared';

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
/** Потолок по времени: сетевая папка не должна держать поиск вечно. */
export const SCAN_TIMEOUT_MS = 30000;
/** Потолок на одну картинку в превью (гигабайтная фотография — не наш случай). */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** Сколько выданных id картинок держим в реестре. */
export const MAX_IMAGE_REGISTRY = 5000;

export class FolderScanError extends Error {}

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

type ScanOutcome = {
  folders: ScannedFolder[];
  files: ScannedFile[];
  unreadable: FileSearchUnreadable[];
  hitDepthLimit: boolean;
  hitFolderLimit: boolean;
  hitFileLimit: boolean;
};

function joinRelative(relativePath: string, name: string): string {
  return relativePath ? `${relativePath}${sep}${name}` : name;
}

/**
 * Обход дерева выбранной папки.
 *
 * Потолки: глубина вложенности, число папок, число файлов, время. Недоступная
 * папка не роняет поиск: она уезжает в `unreadable` с полным путём, обход идёт
 * дальше.
 */
async function scanSourceTree(
  rootPath: string,
  sourceName: string,
  deadline: number,
): Promise<ScanOutcome> {
  const folders: ScannedFolder[] = [];
  const files: ScannedFile[] = [];
  const unreadable: FileSearchUnreadable[] = [];
  let hitDepthLimit = false;
  let hitFolderLimit = false;
  let hitFileLimit = false;

  const walk = async (dirPath: string, relativePath: string, level: number): Promise<void> => {
    if (Date.now() > deadline) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      unreadable.push({
        path: dirPath,
        name: basename(dirPath) || sourceName,
        reason: 'Папка недоступна — выберите её заново',
      });
      return;
    }
    for (const entry of entries) {
      if (Date.now() > deadline) return;
      const name = entry.name;
      const childPath = join(dirPath, name);
      const childRelative = joinRelative(relativePath, name);
      if (entry.isDirectory()) {
        if (folders.length >= MAX_SCANNED_FOLDERS) {
          hitFolderLimit = true;
          continue;
        }
        if (level + 1 > MAX_FOLDER_DEPTH) {
          hitDepthLimit = true;
          continue;
        }
        folders.push({ relativePath: childRelative, name, absolutePath: childPath });
        await walk(childPath, childRelative, level + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_SCANNED_FILES) {
        hitFileLimit = true;
        return;
      }
      let size: number | null = null;
      let modifiedAt: number | null = null;
      try {
        const st = await stat(childPath);
        size = st.size;
        modifiedAt = st.mtimeMs;
      } catch {
        // Файл исчез между чтением папки и stat — пропускаем: поиск идёт дальше.
      }
      files.push({
        relativePath: childRelative,
        name,
        absolutePath: childPath,
        size,
        modifiedAt,
        isImage: isFileSearchImage(name),
      });
    }
  };

  await walk(rootPath, '', 0);
  return { folders, files, unreadable, hitDepthLimit, hitFolderLimit, hitFileLimit };
}

/**
 * Поиск по названиям в выбранных папках.
 *
 * Находка — папка, в названии которой есть запрос, либо файл с таким
 * названием. Для папки показываем её содержимое (картинки внутри), для файла —
 * сам файл.
 */
export async function searchFolderSources(
  sources: readonly FileSearchFolderSource[],
  rawQuery: string,
): Promise<FileSearchFolderResult> {
  const started = Date.now();
  const query = normalizeFileSearchQuery(rawQuery);
  const matches: FileSearchFolderMatch[] = [];
  const images: FileSearchFolderImage[] = [];
  const unreadable: FileSearchUnreadable[] = [];
  const notes: string[] = [];
  let scannedFolders = 0;

  if (!query) {
    return { query, matches, images, unreadable, notes, scannedFolders, durationMs: Date.now() - started };
  }

  const deadline = started + SCAN_TIMEOUT_MS;
  const lowerQuery = query.toLowerCase();

  for (const source of sources) {
    if (Date.now() > deadline) {
      notes.push(`Поиск остановлен по времени (${Math.round(SCAN_TIMEOUT_MS / 1000)} с) — часть папок не просмотрена`);
      break;
    }
    let outcome: ScanOutcome;
    try {
      outcome = await scanSourceTree(source.path, source.name, deadline);
    } catch (e) {
      unreadable.push({
        path: source.path,
        name: source.name,
        reason: e instanceof FolderScanError ? e.message : 'Папка недоступна — выберите её заново',
      });
      continue;
    }
    scannedFolders += outcome.folders.length + 1;
    unreadable.push(...outcome.unreadable);
    if (outcome.hitDepthLimit) {
      notes.push(`Глубже ${MAX_FOLDER_DEPTH} уровней вложенности не смотрели — часть папок пропущена`);
    }
    if (outcome.hitFolderLimit) {
      notes.push(`Просмотрено не больше ${MAX_SCANNED_FOLDERS} папок — остальные пропущены`);
    }
    if (outcome.hitFileLimit) {
      notes.push(`Просмотрено не больше ${MAX_SCANNED_FILES} файлов — остальные пропущены`);
    }

    // Находки по названию папки.
    //
    // Проверяется и сама папка-источник: оператор мог добавить сразу папку
    // двигателя («Э06АТ0889») — тогда по её названию мы и обязаны её найти,
    // вместе с содержимым.
    const matchedFolderPaths: string[] = [];
    const folderCandidates: ScannedFolder[] = [
      { relativePath: '', name: source.name, absolutePath: source.path },
      ...outcome.folders,
    ];
    for (const folder of folderCandidates) {
      if (!folder.name.toLowerCase().includes(lowerQuery)) continue;
      if (matches.length >= MAX_FOLDER_MATCHES) {
        notes.push(`Находок больше ${MAX_FOLDER_MATCHES} — показываем первые`);
        break;
      }
      matchedFolderPaths.push(folder.relativePath);
      const key = folderMatchKey({ sourceId: source.id, relativePath: folder.relativePath, matchedBy: 'folder' });
      const prefix = folder.relativePath ? folder.relativePath + sep : '';
      const inside = outcome.files.filter((file) => file.isImage && file.relativePath.startsWith(prefix));
      const shown = inside.slice(0, MAX_IMAGES_PER_MATCH);
      if (inside.length > shown.length) {
        notes.push(`«${folder.name}»: показаны первые ${shown.length} картинок из ${inside.length}`);
      }
      matches.push({
        key,
        sourceId: source.id,
        sourceName: source.name,
        relativePath: folder.relativePath,
        name: folder.name,
        matchedBy: 'folder',
        imageCount: shown.length,
      });
      for (const file of shown) {
        images.push({
          id: registerImage(file.absolutePath, file.name),
          matchKey: key,
          name: file.name,
          relativePath: file.relativePath,
          size: file.size,
        });
      }
    }

    // Находки по названию файла. Файл внутри уже найденной папки отдельной
    // находкой не показываем — содержимое папки оператор и так видит.
    for (const file of outcome.files) {
      if (!file.name.toLowerCase().includes(lowerQuery)) continue;
      if (matches.length >= MAX_FOLDER_MATCHES) {
        notes.push(`Находок больше ${MAX_FOLDER_MATCHES} — показываем первые`);
        break;
      }
      const inMatchedFolder = matchedFolderPaths.some((folderPath) =>
        folderPath ? file.relativePath.startsWith(folderPath + sep) : true,
      );
      if (inMatchedFolder) continue;
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
    }
  }

  return {
    query,
    matches,
    images,
    unreadable,
    notes: [...new Set(notes)],
    scannedFolders,
    durationMs: Date.now() - started,
  };
}

/** Расширение файла в нижнем регистре — для mime-типа превью. */
export function imageExtensionOf(path: string): string {
  return fileSearchImageExtension(path);
}
