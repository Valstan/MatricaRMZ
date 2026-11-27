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
  /**
   * Поиск остановлен по команде оператора («Отмена»): отдан частичный
   * результат — то, что успели найти до остановки.
   */
  cancelled: boolean;
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

/**
 * Картинка-находка ДО выдачи id (промт КАРМАНА #180).
 *
 * Раньше совпадения и картинки считались прямо в обходе папок, и тем же
 * кодом считались дважды: один раз — обходом диска, второй — по карте
 * индекса. Два пути давали бы разный результат на одних данных, и «поиск по
 * индексу» было бы нечем доказать. Теперь правило одно — здесь, а обход диска
 * и карта индекса просто подставляют в него свои записи.
 *
 * `absolutePath` — путь на диске: его знает только главный процесс (renderer
 * получает id, а не путь — тот же класс защиты, что у `consumeIssuedPath`).
 */
export type FileSearchFolderImageCandidate = {
  /** Ключ совпадения, в котором найдена картинка. */
  matchKey: string;
  name: string;
  relativePath: string;
  size: number | null;
  /** Абсолютный путь на диске — только для главного процесса. */
  absolutePath: string;
};

/** Настройки сборщика совпадений. */
export type FileSearchFolderCollectorOptions = {
  /** id источника-папки. */
  sourceId: string;
  /** Имя источника-папки (показывается в находке). */
  sourceName: string;
  /** Область совпадения: `folder` — только по названию папки. */
  scope: FileSearchFolderSearchScope;
  /** Нормализованный запрос (как его понимает `normalizeFileSearchQuery`). */
  query: string;
  /** Разделитель относительных путей (`\` на Windows). */
  separator: string;
  /** Потолок числа находок. */
  maxMatches: number;
  /** Потолок числа картинок в одной находке. */
  maxImagesPerMatch: number;
};

/**
 * Сборщик совпадений по папкам — ОДНО правило для обхода диска и для карты
 * индекса (промт КАРМАНА #180).
 *
 * Считает находки ВО ВРЕМЯ обхода, а не после: оператор видит найденное
 * сразу, и счётчик «найдено» в полосе прогресса не расходится с результатом.
 * Поэтому сборщик наполняется по мере обхода, а не собирается в конце.
 */
export class FileSearchFolderMatchCollector {
  /** Находки: папки и файлы. */
  readonly matches: FileSearchFolderMatch[] = [];
  /** Картинки находок (без id — id выдаёт главный процесс). */
  readonly images: FileSearchFolderImageCandidate[] = [];
  /** Замечания оператору: «находок больше 200», «показаны первые N из M». */
  readonly notes: string[] = [];

  private readonly lowerQuery: string;
  private readonly allowFileMatches: boolean;
  /** Совпавшие папки: относительный путь → находка. */
  private readonly matchedByPath = new Map<string, FileSearchFolderMatch>();
  /** Сколько картинок ВСЕГО внутри совпавшей папки. */
  private readonly imageTotals = new Map<string, number>();
  /** Сколько картинок уже показано по совпавшей папке. */
  private readonly imageShown = new Map<string, number>();

  constructor(private readonly opts: FileSearchFolderCollectorOptions) {
    this.lowerQuery = String(opts.query ?? '').toLowerCase();
    this.allowFileMatches = folderScopeAllowsFileMatches(opts.scope);
  }

  /**
   * Папка: её имя может совпасть с запросом — тогда это находка целиком,
   * вместе со всем содержимым.
   */
  addFolder(folder: { relativePath: string; name: string }): void {
    if (!this.lowerQuery) return;
    if (!folder.name.toLowerCase().includes(this.lowerQuery)) return;
    if (this.matches.length >= this.opts.maxMatches) {
      this.notes.push(`Находок больше ${this.opts.maxMatches} — показываем первые`);
      return;
    }
    const key = folderMatchKey({
      sourceId: this.opts.sourceId,
      relativePath: folder.relativePath,
      matchedBy: 'folder',
    });
    const match: FileSearchFolderMatch = {
      key,
      sourceId: this.opts.sourceId,
      sourceName: this.opts.sourceName,
      relativePath: folder.relativePath,
      name: folder.name,
      matchedBy: 'folder',
      imageCount: 0,
    };
    this.matches.push(match);
    this.matchedByPath.set(folder.relativePath, match);
    this.imageTotals.set(folder.relativePath, 0);
    this.imageShown.set(folder.relativePath, 0);
  }

  /**
   * Файл: имя может совпасть с запросом (тогда это отдельная находка), а
   * картинка попадает в каждую совпавшую папку, внутри которой она лежит.
   */
  addFile(file: {
    relativePath: string;
    name: string;
    absolutePath: string;
    isImage: boolean;
    size: number | null;
  }): void {
    if (file.isImage) this.attachImage(file);
    this.addFileMatch(file);
  }

  /** Итоговые примечания: «показаны первые N картинок из M». */
  finish(): void {
    for (const [folderPath, match] of this.matchedByPath) {
      const total = this.imageTotals.get(folderPath) ?? 0;
      const shown = this.imageShown.get(folderPath) ?? 0;
      if (total > shown) {
        this.notes.push(`«${match.name}»: показаны первые ${shown} картинок из ${total}`);
      }
    }
  }

  /** Картинка попадает в каждую совпавшую папку, внутри которой она лежит. */
  private attachImage(file: {
    relativePath: string;
    name: string;
    absolutePath: string;
    size: number | null;
  }): void {
    for (const [folderPath, match] of this.matchedByPath) {
      const prefix = folderPath ? folderPath + this.opts.separator : '';
      if (!file.relativePath.startsWith(prefix)) continue;
      this.imageTotals.set(folderPath, (this.imageTotals.get(folderPath) ?? 0) + 1);
      const shown = this.imageShown.get(folderPath) ?? 0;
      if (shown >= this.opts.maxImagesPerMatch) continue;
      this.imageShown.set(folderPath, shown + 1);
      match.imageCount = shown + 1;
      this.images.push({
        matchKey: match.key,
        name: file.name,
        relativePath: file.relativePath,
        size: file.size,
        absolutePath: file.absolutePath,
      });
    }
  }

  /**
   * Находка по названию файла — если имя подходит и файл не внутри найденной
   * папки (внутри найденной папки файл уже показан вместе с ней).
   */
  private addFileMatch(file: {
    relativePath: string;
    name: string;
    absolutePath: string;
    isImage: boolean;
    size: number | null;
  }): void {
    if (!this.allowFileMatches) return;
    if (!this.lowerQuery) return;
    if (!file.name.toLowerCase().includes(this.lowerQuery)) return;
    if (this.matches.length >= this.opts.maxMatches) {
      this.notes.push(`Находок больше ${this.opts.maxMatches} — показываем первые`);
      return;
    }
    for (const folderPath of this.matchedByPath.keys()) {
      const inside = folderPath ? file.relativePath.startsWith(folderPath + this.opts.separator) : true;
      if (inside) return;
    }
    const key = folderMatchKey({
      sourceId: this.opts.sourceId,
      relativePath: file.relativePath,
      matchedBy: 'file',
    });
    this.matches.push({
      key,
      sourceId: this.opts.sourceId,
      sourceName: this.opts.sourceName,
      relativePath: file.relativePath,
      name: file.name,
      matchedBy: 'file',
      imageCount: file.isImage ? 1 : 0,
    });
    if (file.isImage) {
      this.images.push({
        matchKey: key,
        name: file.name,
        relativePath: file.relativePath,
        size: file.size,
        absolutePath: file.absolutePath,
      });
    }
  }
}
