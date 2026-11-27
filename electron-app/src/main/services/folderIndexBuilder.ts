// Построение карты дерева папки (промт КАРМАНА #180).
//
// Здесь — сам обход и сбор карты. Отдельный файл нужен, чтобы обход был
// ПРОВЕРЯЕМ: процесс индексации (`workers/folderIndexWorker.ts`) — тонкая
// обёртка над этой функцией (портал сообщений), а тесты зовут её напрямую,
// без поднятия процесса.
//
// КАРТА — список записей: путь, имя, тип, размер, дата. По ней поиск отвечает,
// не трогая диск.

import { readdir, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

import {
  isFileSearchImage,
  type FileSearchFolderIndex,
  type FileSearchFolderIndexEntry,
  type FileSearchUnreadable,
} from '@matricarmz/shared';

/** Что построить и с какими потолками. */
export type FolderIndexBuildRequest = {
  /** id источника-папки, к которому относится карта. */
  sourceId: string;
  /** Корень обхода. */
  rootPath: string;
  /** Потолок глубины вложенности. */
  maxDepth: number;
  /** Потолок числа папок. */
  maxFolders: number;
  /** Потолок числа файлов. */
  maxFiles: number;
  /** Пауза между чтениями папок (мс) — ограничение скорости. */
  rateLimitMs: number;
};

/** Ход обхода и отмена. */
export type FolderIndexBuildHooks = {
  /** Папок и файлов просмотрено; что читается прямо сейчас. */
  onProgress?: (progress: { folders: number; files: number; current: string | null }) => void;
  /** true — пора остановиться (оператор отменил или сработал сторож). */
  isCancelled?: () => boolean;
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function statSafe(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    return await stat(path);
  } catch {
    // Файл исчез или недоступен — карта строим без его метаданных.
    return null;
  }
}

/**
 * Обойти дерево папки и собрать карту.
 *
 * Порядок записей — обход в глубину, родитель раньше детей: так карта
 * «разворачивается» в тот же порядок, в каком считались бы находки.
 */
export async function buildFolderIndex(
  req: FolderIndexBuildRequest,
  hooks: FolderIndexBuildHooks = {},
): Promise<FileSearchFolderIndex> {
  const entries: FileSearchFolderIndexEntry[] = [];
  const unreadable: FileSearchUnreadable[] = [];
  const notes: string[] = [];
  let folders = 0;
  let files = 0;
  let hitDepth = false;
  let hitFolderLimit = false;
  let hitFileLimit = false;

  const rootStat = await statSafe(req.rootPath);
  const rootName = basename(req.rootPath) || req.rootPath;
  // Корень — первая запись карты: по его имени папка-источник тоже может
  // совпасть с запросом оператора.
  entries.push({
    relativePath: '',
    name: rootName,
    kind: 'folder',
    size: null,
    modifiedAt: rootStat?.mtimeMs ?? null,
    isImage: false,
  });
  folders += 1;

  const walk = async (dirPath: string, relativePath: string, level: number): Promise<void> => {
    if (hooks.isCancelled?.()) return;
    if (level > req.maxDepth) {
      hitDepth = true;
      return;
    }
    let dirEntries;
    try {
      dirEntries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      unreadable.push({
        path: dirPath,
        name: basename(dirPath) || dirPath,
        reason: 'Папка недоступна — выберите её заново',
      });
      return;
    }
    for (const entry of dirEntries) {
      if (hooks.isCancelled?.()) return;
      const name = entry.name;
      const childPath = join(dirPath, name);
      const childRelative = relativePath ? `${relativePath}${sep}${name}` : name;
      if (entry.isDirectory()) {
        if (folders >= req.maxFolders) {
          hitFolderLimit = true;
          continue;
        }
        folders += 1;
        const st = await statSafe(childPath);
        entries.push({
          relativePath: childRelative,
          name,
          kind: 'folder',
          size: null,
          modifiedAt: st?.mtimeMs ?? null,
          isImage: false,
        });
        await walk(childPath, childRelative, level + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files >= req.maxFiles) {
        hitFileLimit = true;
        return;
      }
      files += 1;
      const st = await statSafe(childPath);
      entries.push({
        relativePath: childRelative,
        name,
        kind: 'file',
        size: st?.size ?? null,
        modifiedAt: st?.mtimeMs ?? null,
        isImage: isFileSearchImage(name),
      });
    }
    // Ограничение скорости: после каждой папки — пауза. Сеть получает работу
    // порциями, а не сплошным потоком.
    await sleep(req.rateLimitMs);
    hooks.onProgress?.({ folders, files, current: basename(dirPath) || dirPath });
  };

  await walk(req.rootPath, '', 0);
  hooks.onProgress?.({ folders, files, current: null });

  if (hitDepth) {
    notes.push(`Глубже ${req.maxDepth} уровней вложенности не смотрели — часть папок пропущена`);
  }
  if (hitFolderLimit) {
    notes.push(`Просмотрено не больше ${req.maxFolders} папок — остальные пропущены`);
  }
  if (hitFileLimit) {
    notes.push(`Просмотрено не больше ${req.maxFiles} файлов — остальные пропущены`);
  }

  const rootStatFinal = await statSafe(req.rootPath);
  return {
    sourceId: req.sourceId,
    rootPath: req.rootPath,
    builtAt: Date.now(),
    rootModifiedAt: rootStatFinal?.mtimeMs ?? rootStat?.mtimeMs ?? null,
    folderCount: folders,
    fileCount: files,
    entries,
    unreadable,
    notes,
  };
}
