// Поиск по папкам для модуля «Поиск по файлам» (промт КАРМАНА #88, план #89;
// разбор медленного обхода, карта индекса и фоновая индексация — промт
// КАРМАНА #180).
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
// ЧТО БЫЛО МЕДЛЕННО (промт #180, замер — `docs/evidence/folder-search-180/`).
// Обход шёл СТРОГО ПО ОДНОЙ папке: прочитал папку — зашёл в её содержимое —
// потом в следующую; несколько добавленных папок тоже по очереди. И на КАЖДЫЙ
// файл делался отдельный запрос метаданных (размер и дата) со своим потолком
// ожидания. На сетевой папке это тысячи последовательных сетевых запросов —
// отсюда «идёт по одной папке». Индекса и кэша не было вовсе: каждый поиск —
// полный обход с нуля, поэтому первая папка шла «тёплой», а вторая «холодной».
// Версия «переполненный индекс» отвергнута замером: индекса в коде не было.
//
// ЧТО СТАЛО (промт #180).
//  * Обход идёт с ОГРАНИЧЕННЫМ ПАРАЛЛЕЛИЗМОМ (`FOLDER_WALK_CONCURRENCY`),
//    а не строго по одной папке.
//  * Метаданные файла НЕ берутся там, где они не нужны: для совпадения по
//    имени они не нужны вообще, а размер нужен только картинкам, которые
//    попали в результат. Такие размеры добираются ОДНИМ проходом с
//    ограниченной параллельностью, а не тысячей отдельных запросов.
//  * Дерево папки индексируется В ФОНЕ отдельным процессом, а следующий поиск
//    по той же папке отвечает по карте индекса (`FolderIndexLookup`).
//
// ПОТОЛКИ. Потолки по КОЛИЧЕСТВУ (глубина вложенности, число папок, число
// файлов, число находок и число картинок на находку) обязательны: папок и
// картинок может быть много.
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
  isFileSearchImage,
  normalizeFileSearchQuery,
  normalizeFileSearchFolderScope,
  FileSearchFolderMatchCollector,
  type FileSearchFolderImage,
  type FileSearchFolderImageCandidate,
  type FileSearchFolderIndex,
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
 * Сколько папок читать ОДНОВРЕМЕННО (промт КАРМАНА #180).
 *
 * Было строго по одной: папка ждала папку, и добавленные папки тоже по очереди.
 * Теперь обход идёт с ограниченным параллелизмом — сеть получает несколько
 * запросов подряд вместо одного, и обход большого дерева идёт в разы быстрее.
 * Потолок небольшой намеренно: оператор не должен чувствовать, что программа
 * «забрала сеть себе».
 */
export const FOLDER_WALK_CONCURRENCY = 4;
/**
 * Сколько запросов метаданных идёт одновременно (промт КАРМАНА #180).
 *
 * Размер нужен только картинкам, попавшим в результат, и берётся одним
 * проходом — но и он не должен выбрать сеть.
 */
export const FOLDER_SIZE_CONCURRENCY = 8;
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

/**
 * Откуда берётся карта индекса (промт КАРМАНА #180).
 *
 * Подставляется главным процессом: в тестах — нет (тогда поиск идёт по диску,
 * как раньше), в программе — настоящий сервис индексации.
 */
export type FolderIndexLookup = {
  /** Свежая карта источника — или null (карты нет или она протухла). */
  load: (source: FileSearchFolderSource) => Promise<FileSearchFolderIndex | null>;
  /** Карты нет — её надо построить в фоне (не мешая оператору). */
  requestBuild: (source: FileSearchFolderSource) => void;
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
 * Добираем размеры картинок, попавших в результат (промт КАРМАНА #180).
 *
 * Раньше размер и дата запрашивались по КАЖДОМУ файлу обхода, последовательно,
 * каждый со своим потолком ожидания: на сетевой папке это тысячи сетевых
 * запросов подряд. Для совпадения по имени эти данные не нужны вообще, а
 * размер нужен только картинкам результата — их немного, и берём их одним
 * проходом с ограниченной параллельностью.
 */
async function fillImageSizes(
  images: FileSearchFolderImageCandidate[],
  signal?: AbortSignal,
): Promise<void> {
  const pending = images.filter((image) => image.size == null);
  if (pending.length === 0) return;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const i = cursor;
      cursor += 1;
      if (i >= pending.length) return;
      const image = pending[i];
      if (!image) return;
      try {
        const st = await statWithTimeout(image.absolutePath, signal);
        image.size = st.size;
      } catch {
        // Файл исчез или сеть не ответила — размер останется неизвестным:
        // это не повод ронять поиск.
      }
    }
  };
  const workers = Math.min(FOLDER_SIZE_CONCURRENCY, pending.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/**
 * Служебный переключатель: искать по диску, игнорируя карту индекса.
 *
 * Нужен для ПРОВЕРКИ СТОРОЖА (промт КАРМАНА #180): сторож падает, если поиск
 * по папке снова пошёл обходом диска вместо карты. Чтобы убедиться, что
 * сторож вообще ловит разницу, карту отключают этой переменной окружения —
 * и видят, что обход диска действительно начинается. В обычной работе
 * переменная не выставлена, и поиск идёт по карте.
 */
export function folderIndexDisabled(): boolean {
  return String(process.env.MATRICA_FOLDER_SEARCH_FORCE_DISK ?? '').trim() === '1';
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
 * ГДЕ ИЩЕМ (промт КАРМАНА #180). Если у источника есть СВЕЖАЯ карта индекса —
 * ищем по ней, не трогая диск (второй поиск по той же папке отвечает сразу).
 * Карты нет или она протухла — идём по диску и просим построить карту в фоне.
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
    /** Карта индекса: где взять и когда построить (промт КАРМАНА #180). */
    index?: FolderIndexLookup;
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

    /** Карта индекса источника — если есть свежая, идём по ней, а не по диску. */
    const index = options?.index && !folderIndexDisabled() ? await options.index.load(source) : null;

    /** Совпавшие папки источника: относительный путь → находка. */
    const collector = new FileSearchFolderMatchCollector({
      sourceId: source.id,
      sourceName: source.name,
      scope,
      query: lowerQuery,
      separator: sep,
      maxMatches: MAX_FOLDER_MATCHES,
      maxImagesPerMatch: MAX_IMAGES_PER_MATCH,
    });

    if (index) {
      // ── Поиск по карте: диск не трогаем совсем. ──────────────────────────
      for (const entry of index.entries) {
        if (entry.kind === 'folder') {
          collector.addFolder({ relativePath: entry.relativePath, name: entry.name });
        } else {
          collector.addFile({
            relativePath: entry.relativePath,
            name: entry.name,
            absolutePath: join(source.path, entry.relativePath),
            isImage: entry.isImage,
            size: entry.size,
          });
        }
      }
      collector.finish();
      matches.push(...collector.matches);
      for (const image of collector.images) {
        images.push({
          id: registerImage(image.absolutePath, image.name),
          matchKey: image.matchKey,
          name: image.name,
          relativePath: image.relativePath,
          size: image.size,
        });
      }
      unreadable.push(...(index.unreadable ?? []));
      notes.push(...(index.notes ?? []));
      scannedFolders += index.folderCount;
      scannedSources += 1;
      report(null);
      continue;
    }

    // ── Обход диска ──────────────────────────────────────────────────────────
    // Сама папка-источник — тоже кандидат на совпадение: оператор мог добавить
    // сразу папку двигателя («Э06АТ0889») — тогда по её названию мы и обязаны её
    // найти, вместе с содержимым.
    collector.addFolder({ relativePath: '', name: source.name });

    let hitDepthLimit = false;
    let hitFolderLimit = false;
    let hitFileLimit = false;
    let sourceFolders = 0;
    let sourceFiles = 0;

    /** Очередь папок к прочтению и число занятых рабочих мест. */
    const queue: { dirPath: string; relativePath: string; level: number }[] = [];
    let cursor = 0;
    let busy = 0;
    /** Ожидающие пробуждения рабочих: очередь пополнилась — их можно будить. */
    const waiters: (() => void)[] = [];

    const wake = () => {
      const list = waiters.splice(0, waiters.length);
      for (const resolve of list) resolve();
    };

    /** Прочитать папку и разложить её содержимое: папки — в очередь, файлы — в находки. */
    const processDir = async (task: { dirPath: string; relativePath: string; level: number }): Promise<void> => {
      if (signal?.aborted) {
        cancelled = true;
        return;
      }
      const dirName = basename(task.dirPath) || source.name;
      report(dirName);
      let entries: Dirent[];
      try {
        entries = await readFolderEntries(task.dirPath, signal);
      } catch (e) {
        if (signal?.aborted || e instanceof SearchCancelledError) {
          cancelled = true;
          return;
        }
        unreadable.push({
          path: task.dirPath,
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
        const childPath = join(task.dirPath, name);
        const childRelative = joinRelative(task.relativePath, name);
        if (entry.isDirectory()) {
          if (sourceFolders >= MAX_SCANNED_FOLDERS) {
            hitFolderLimit = true;
            continue;
          }
          if (task.level + 1 > MAX_FOLDER_DEPTH) {
            hitDepthLimit = true;
            continue;
          }
          sourceFolders += 1;
          scannedFolders += 1;
          // Папка становится находкой СЕЙЧАС, до чтения её содержимого: иначе
          // файл внутри неё успел бы стать отдельной находкой.
          collector.addFolder({ relativePath: childRelative, name });
          queue.push({ dirPath: childPath, relativePath: childRelative, level: task.level + 1 });
          wake();
          continue;
        }
        if (!entry.isFile()) continue;
        if (sourceFiles >= MAX_SCANNED_FILES) {
          hitFileLimit = true;
          return;
        }
        sourceFiles += 1;
        collector.addFile({
          relativePath: childRelative,
          name,
          absolutePath: childPath,
          isImage: isFileSearchImage(name),
          // Размер добираем потом, одним проходом: для совпадения по имени он
          // не нужен, а по одному запросу на файл сеть не выдержит.
          size: null,
        });
      }
    };

    /** Рабочий обхода: берёт папки из очереди, пока они есть. */
    const workerLoop = async (): Promise<void> => {
      for (;;) {
        if (signal?.aborted) return;
        if (cursor < queue.length) {
          const task = queue[cursor];
          cursor += 1;
          if (!task) continue;
          busy += 1;
          try {
            await processDir(task);
          } finally {
            busy -= 1;
            wake();
          }
          continue;
        }
        // Очередь пуста — ждём, пока её пополнит другой рабочий.
        if (busy === 0) return;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    };

    queue.push({ dirPath: source.path, relativePath: '', level: 0 });
    // Рабочих столько же, сколько папок читаем одновременно: параллелизм
    // относится к ЧТЕНИЮ папок внутри одного источника, а не к числу
    // источников (одна папка-источник — это уже дерево на сотни папок).
    const workers = FOLDER_WALK_CONCURRENCY;
    try {
      await Promise.all(Array.from({ length: workers }, () => workerLoop()));
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

    // Размеры картинок результата — одним проходом (см. `fillImageSizes`).
    await fillImageSizes(collector.images, signal);

    collector.finish();
    matches.push(...collector.matches);
    for (const image of collector.images) {
      images.push({
        id: registerImage(image.absolutePath, image.name),
        matchKey: image.matchKey,
        name: image.name,
        relativePath: image.relativePath,
        size: image.size,
      });
    }

    // Корень источника — тоже просмотренная папка (как было).
    scannedFolders += 1;
    scannedSources += 1;

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

    // Карты нет — строим её в фоне, чтобы следующий поиск отвечал по карте.
    options?.index?.requestBuild(source);
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
