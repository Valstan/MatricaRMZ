import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import { dirname, join } from 'node:path';

import {
  FILE_SEARCH_DIALOG_FILTERS,
  normalizeFileSearchFolderScope,
  type FileSearchEngineSuggestion,
  type FileSearchFolderResult,
  type FileSearchFolderSource,
  type FileSearchFolderSearchScope,
  type FileSearchResult,
  type FileSearchSource,
} from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';
import { findEngineByExactNumber, listEngineCharacteristicDefs } from '../../services/engineExactLookupService.js';
import { suggestEnginesByNumberFragment } from '../../services/engineNumberSuggestionService.js';
import {
  SEARCH_SOURCE_EXTENSIONS,
  describeSearchSource,
  readSearchContext,
  searchFileSources,
  sourceIdForPath,
} from '../../services/fileSearchService.js';
import {
  MAX_FOLDER_MATCHES,
  describeFolderSource,
  folderSourceIdForPath,
  resolveImagePath,
  searchFolderSources,
} from '../../services/fileSearchFolderService.js';
import { readLocalImagePreview } from '../../services/localImagePreview.js';
import { osPrintWizardAvailable } from '../../services/localImagePrint.js';
import { photosAssemblePdfLocalPaths } from '../../services/fileService.js';
import { printPhotos } from '../../services/photoPrint.js';
import { removeStagedFolder, stageLocalFiles } from '../../services/localFileStaging.js';
import { resolveReferenceLabels } from '../../services/fileSearchReferenceService.js';
import { SettingsKey, settingsGetString, settingsSetString } from '../../services/settingsStore.js';

type Err = { ok: false; error: string };

const MAX_SOURCES = 50;
/** Потолок папок-источников: папок у оператора немного, список — для наглядности. */
const MAX_FOLDERS = 30;

function parseSources(raw: unknown): FileSearchSource[] {
  if (!Array.isArray(raw)) return [];
  const out: FileSearchSource[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item == null) continue;
    const rec = item as Record<string, unknown>;
    const path = String(rec.path ?? '').trim();
    if (!path) continue;
    const kind = String(rec.kind ?? '');
    if (kind !== 'excel' && kind !== 'word' && kind !== 'text') continue;
    out.push({
      id: String(rec.id ?? sourceIdForPath(path)),
      path,
      name: String(rec.name ?? path),
      kind,
      addedAt: Number(rec.addedAt ?? 0),
      size: rec.size == null ? null : Number(rec.size),
      modifiedAt: rec.modifiedAt == null ? null : Number(rec.modifiedAt),
    });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** Хранилище источников — карта по пользователю: у каждого свой список файлов. */
function parseSourceMap(raw: string | null): Record<string, FileSearchSource[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed == null) return {};
  const out: Record<string, FileSearchSource[]> = {};
  for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const sources = parseSources(value);
    if (sources.length > 0) out[userId] = sources;
  }
  return out;
}

/** Папки-источники: та же логика, что у файлов, но у папки нет «типа содержимого». */
function parseFolders(raw: unknown): FileSearchFolderSource[] {
  if (!Array.isArray(raw)) return [];
  const out: FileSearchFolderSource[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item == null) continue;
    const rec = item as Record<string, unknown>;
    const path = String(rec.path ?? '').trim();
    if (!path) continue;
    out.push({
      id: String(rec.id ?? folderSourceIdForPath(path)),
      path,
      name: String(rec.name ?? path),
      addedAt: Number(rec.addedAt ?? 0),
    });
    if (out.length >= MAX_FOLDERS) break;
  }
  return out;
}

function parseFolderMap(raw: string | null): Record<string, FileSearchFolderSource[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed == null) return {};
  const out: Record<string, FileSearchFolderSource[]> = {};
  for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const folders = parseFolders(value);
    if (folders.length > 0) out[userId] = folders;
  }
  return out;
}

/**
 * Модуль «Поиск по файлам» (промт КАРМАНА #32).
 *
 * Файлы читает главный процесс: renderer получает только результаты. Пути к
 * источникам хранятся машинно-локально (`sync_state`) — профиль роумится, а
 * путь на другой машине невалиден.
 */
export function registerFileSearchIpc(ctx: IpcContext) {
  ipcMain.handle('fileSearch:pick', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow();
      const opts = {
        title: 'Выберите файлы для поиска',
        properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
        filters: FILE_SEARCH_DIALOG_FILTERS.map((f) => ({ name: f.name, extensions: f.extensions })),
      };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      const paths = (r.filePaths ?? []).map((p) => String(p)).filter(Boolean);
      if (paths.length === 0) return { ok: false as const, error: 'cancelled' };
      const sources: FileSearchSource[] = [];
      const skipped: string[] = [];
      for (const path of paths) {
        try {
          sources.push(await describeSearchSource(path));
        } catch (e) {
          skipped.push(`${path}: ${String(e)}`);
        }
      }
      return {
        ok: true as const,
        sources,
        skipped,
        supported: SEARCH_SOURCE_EXTENSIONS,
      };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle(
    'fileSearch:search',
    async (_e, args: { sources?: FileSearchSource[]; query?: string }): Promise<
      { ok: true; result: FileSearchResult } | Err
    > => {
      try {
        const sources = Array.isArray(args?.sources) ? args.sources : [];
        const result = await searchFileSources(sources, String(args?.query ?? ''));
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  ipcMain.handle(
    'fileSearch:context',
    async (
      _e,
      args: { source?: FileSearchSource; paragraphIndex?: number; count?: number },
    ): Promise<{ ok: true; paragraphs: string[] } | Err> => {
      try {
        const source = args?.source;
        if (!source?.path) return { ok: false, error: 'Не указан файл' };
        const paragraphs = await readSearchContext(source, Number(args?.paragraphIndex ?? 0), Number(args?.count ?? 10));
        return { ok: true, paragraphs };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  ipcMain.handle('fileSearch:sources:get', async () => {
    try {
      const userId = (await ctx.currentActor()) || 'local';
      const raw = await settingsGetString(ctx.sysDb, SettingsKey.FileSearchSources);
      const all = parseSourceMap(raw);
      return { ok: true as const, userId, sources: all[userId] ?? [] };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle(
    'fileSearch:sources:set',
    async (_e, args: { sources?: FileSearchSource[] }): Promise<{ ok: true } | Err> => {
      try {
        const userId = (await ctx.currentActor()) || 'local';
        const sources = Array.isArray(args?.sources) ? args.sources.slice(0, MAX_SOURCES) : [];
        const raw = await settingsGetString(ctx.sysDb, SettingsKey.FileSearchSources);
        const all = parseSourceMap(raw);
        all[userId] = sources;
        await settingsSetString(ctx.sysDb, SettingsKey.FileSearchSources, JSON.stringify(all));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  ipcMain.handle(
    'engine:findExactByNumber',
    async (_e, args: { query?: string }): Promise<
      | { ok: true; engine: Awaited<ReturnType<typeof findEngineByExactNumber>>['engine']; note: string | null }
      | Err
    > => {
      const gate = await requirePermOrResult(ctx, 'engines.view');
      if (!gate.ok) return gate as Err;
      try {
        const result = await findEngineByExactNumber(ctx.dataDb(), String(args?.query ?? ''));
        return { ok: true, engine: result.engine, note: result.note };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  ipcMain.handle('engine:characteristics', async () => {
    const gate = await requirePermOrResult(ctx, 'engines.view');
    if (!gate.ok) return gate as Err;
    try {
      return { ok: true as const, defs: await listEngineCharacteristicDefs(ctx.dataDb()) };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  /**
   * Названия для ссылок карточки: id → номер договора / название заказчика.
   *
   * Право — как на чтение карточки (`engines.view`): ссылки в карточке и так
   * видны, а названия лежат в той же локальной реплике.
   */
  ipcMain.handle(
    'fileSearch:resolveLabels',
    async (_e, args: { ids?: string[] }): Promise<{ ok: true; labels: Record<string, string> } | Err> => {
      const gate = await requirePermOrResult(ctx, 'engines.view');
      if (!gate.ok) return gate as Err;
      try {
        const ids = Array.isArray(args?.ids) ? args.ids.slice(0, 200) : [];
        const labels = await resolveReferenceLabels(ctx.dataDb(), ids);
        return { ok: true, labels };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  // ── Поиск по папкам (промт КАРМАНА #88, план #89) ─────────────────────────
  //
  // Папка с фотографиями двигателей. Поиск идёт ПО НАЗВАНИЮ: оператор вводит
  // номер двигателя и получает папки, в названии которых он есть, вместе с
  // крупными превью их содержимого.
  //
  // Границы те же, что у поиска по файлам: каналы `fileSearch:` гейтятся
  // разделом «Производство», а пути и картинки приходят из main — renderer
  // знает только выданные main id и не может попросить произвольный файл.

  /** Выбор папок-источников: диалог с мультивыбором папок. */
  ipcMain.handle('fileSearch:pickFolder', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow();
      const opts = {
        title: 'Выберите папки с фотографиями',
        properties: ['openDirectory', 'multiSelections'] as ('openDirectory' | 'multiSelections')[],
      };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      const paths = (r.filePaths ?? []).map((p) => String(p)).filter(Boolean);
      if (paths.length === 0) return { ok: false as const, error: 'cancelled' };
      const folders: FileSearchFolderSource[] = [];
      const skipped: string[] = [];
      for (const path of paths) {
        try {
          folders.push(await describeFolderSource(path));
        } catch (e) {
          skipped.push(`${path}: ${String(e)}`);
        }
      }
      return { ok: true as const, folders, skipped };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  /** Список папок-источников этого пользователя на этой машине. */
  ipcMain.handle('fileSearch:folders:get', async () => {
    try {
      const userId = (await ctx.currentActor()) || 'local';
      const raw = await settingsGetString(ctx.sysDb, SettingsKey.FileSearchFolders);
      const all = parseFolderMap(raw);
      return { ok: true as const, userId, folders: all[userId] ?? [] };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  /** Запомнить список папок. Пути машинно-локальные: профиль роумится. */
  ipcMain.handle(
    'fileSearch:folders:set',
    async (_e, args: { folders?: FileSearchFolderSource[] }): Promise<{ ok: true } | Err> => {
      try {
        const userId = (await ctx.currentActor()) || 'local';
        const folders = Array.isArray(args?.folders) ? parseFolders(args.folders.slice(0, MAX_FOLDERS)) : [];
        const raw = await settingsGetString(ctx.sysDb, SettingsKey.FileSearchFolders);
        const all = parseFolderMap(raw);
        all[userId] = folders;
        await settingsSetString(ctx.sysDb, SettingsKey.FileSearchFolders, JSON.stringify(all));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /**
   * Поиск по названиям папок и файлов.
   *
   * Папки берутся из машинно-локального хранилища этого пользователя, а НЕ из
   * аргументов renderer: иначе канал стал бы «обойди любую папку на диске».
   * Оператор добавляет папки кнопкой (диалог выбора) — они и ищутся.
   *
   * `scope` — что считается находкой: `any` (папка или отдельный файл, как
   * было) или `folder` (режим «Фото двигателя»: только папка, и она — целиком,
   * со всеми фотографиями).
   */
  ipcMain.handle(
    'fileSearch:searchFolders',
    async (_e, args: { query?: string; scope?: FileSearchFolderSearchScope }): Promise<
      { ok: true; result: FileSearchFolderResult } | Err
    > => {
      try {
        const userId = (await ctx.currentActor()) || 'local';
        const raw = await settingsGetString(ctx.sysDb, SettingsKey.FileSearchFolders);
        const folders = parseFolderMap(raw)[userId] ?? [];
        const result = await searchFolderSources(folders, String(args?.query ?? ''), {
          scope: normalizeFileSearchFolderScope(args?.scope),
        });
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /**
   * Подсказки номера двигателя по неполному номеру (промт КАРМАНА #155).
   *
   * Оператор набирает в строке поиска последние цифры номера («0889») и ждёт
   * полный номер из базы. Источник — локальная реплика карточек: список всех
   * двигателей в renderer тянуть нельзя, а точечный запрос с лимитом — можно.
   *
   * Право — как на чтение карточки (`engines.view`): подсказка показывает номер
   * двигателя, который и так виден оператору с этим правом.
   */
  ipcMain.handle(
    'fileSearch:engineNumberSuggestions',
    async (_e, args: { q?: string; limit?: number }): Promise<
      { ok: true; suggestions: FileSearchEngineSuggestion[] } | Err
    > => {
      const gate = await requirePermOrResult(ctx, 'engines.view');
      if (!gate.ok) return gate as Err;
      try {
        const rawLimit = args?.limit;
        const suggestions = await suggestEnginesByNumberFragment(ctx.dataDb(), {
          q: String(args?.q ?? ''),
          ...(rawLimit == null ? {} : { limit: Number(rawLimit) }),
        });
        return { ok: true, suggestions };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /**
   * Крупное превью картинки — по id, который main выдал при поиске.
   *
   * Путь renderer не знает и подсунуть не может: так канал не становится
   * «прочитай любой файл с диска».
   */
  ipcMain.handle(
    'fileSearch:imagePreview',
    async (_e, args: { id?: string }): Promise<{ ok: true; dataUrl: string } | Err> => {
      try {
        const resolved = resolveImagePath(String(args?.id ?? ''));
        if (!resolved) return { ok: false, error: 'Картинка не найдена — повторите поиск' };
        const preview = await readLocalImagePreview(resolved.path);
        if (!preview.ok) return { ok: false, error: preview.error };
        return { ok: true, dataUrl: preview.dataUrl };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /**
   * Печать отобранных картинок.
   *
   * Пути берутся из реестра main по выданным id: печатать можно только то,
   * что main сам нашёл в папках оператора.
   *
   * Два режима (промт КАРМАНА #102):
   *  - `dialog` — системный диалог печати, все картинки сразу;
   *  - `os` — СИСТЕМНЫЙ мастер печати фотографий (то, что владелец назвал
   *    «Microsoft Picture Manager»): оператор в системном окне правит размер
   *    и раскладку и жмёт «Печать».
   *
   * Печать идёт через ОБЩИЙ шаг печати картинок (`photoPrint.ts`) — тот же,
   * что у печати вложений из карточки (промт КАРМАНА #159). Отказ называет
   * причину: принтера нет — значит «принтер не найден», а не «отправлено».
   */
  ipcMain.handle(
    'fileSearch:printImages',
    async (_e, args: { ids?: string[]; mode?: 'dialog' | 'os' }): Promise<
      { ok: true; opened?: number; failed?: number; note?: string } | Err
    > => {
      try {
        const ids = Array.isArray(args?.ids) ? args.ids.slice(0, MAX_FOLDER_MATCHES) : [];
        const paths: string[] = [];
        for (const id of ids) {
          const resolved = resolveImagePath(String(id ?? ''));
          if (resolved) paths.push(resolved.path);
        }
        if (paths.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
        const res = await printPhotos(paths, { mode: args?.mode === 'os' ? 'os' : 'dialog' });
        if (!res.ok) return { ok: false, error: res.error };
        return {
          ok: true,
          opened: res.images,
          failed: res.skipped.length,
          ...(res.note ? { note: res.note } : {}),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /**
   * Умеет ли эта машина системный мастер печати фотографий.
   *
   * Renderer про ОС ничего не знает (десктоп и планшет собираются по-разному),
   * поэтому способность спрашивается у main — и кнопка прячется сама.
   */
  ipcMain.handle('fileSearch:printCapabilities', async () => {
    try {
      return { ok: true as const, osPrintWizard: osPrintWizardAvailable() };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  // ── Действия над отмеченными файлами (промт КАРМАНА #158) ─────────────────
  //
  // Файлы из выдачи — ЛОКАЛЬНЫЕ: они лежат в папках оператора, главный процесс
  // выдаёт renderer'у только id. Все двери ниже решают одну задачу: превратить
  // отмеченные id в действия на настоящих файлах, не выпуская путь на диск.

  /** Пути отмеченных файлов — только по id, которые main сам выдал. */
  function localPathsOf(ids: unknown): string[] {
    const list = Array.isArray(ids) ? ids.slice(0, MAX_FOLDER_MATCHES) : [];
    const out: string[] = [];
    for (const id of list) {
      const resolved = resolveImagePath(String(id ?? ''));
      if (resolved) out.push(resolved.path);
    }
    return out;
  }

  /**
   * PDF одним файлом из отмеченных ЛОКАЛЬНЫХ картинок.
   *
   * Дверь `files:assemblePdf` работает по `fileIds` серверных вложений — файлов из
   * выдачи поиска на сервере нет, поэтому для них своя дверь: то же скрытое окно
   * печати → `printToPDF` → диалог сохранения с именем по умолчанию «Фото двигателя».
   */
  ipcMain.handle(
    'fileSearch:assemblePdf',
    async (_e, args: { ids?: string[]; defaultName?: string }): Promise<
      { ok: true; savePath: string } | { ok: false; error: string }
    > => {
      try {
        const paths = localPathsOf(args?.ids);
        if (paths.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
        const parent = BrowserWindow.getFocusedWindow();
        const baseName = String(args?.defaultName || 'Фото двигателя').replaceAll(/[\\/:*?"<>|]+/g, '_');
        const opts = {
          title: 'Сохранить PDF с фотографиями',
          defaultPath: join(app.getPath('desktop'), `${baseName}.pdf`),
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        };
        const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
        const savePath = r.canceled || !r.filePath ? '' : String(r.filePath);
        if (!savePath) return { ok: false, error: 'cancelled' };
        const res = await photosAssemblePdfLocalPaths(paths, savePath);
        if (!res.ok) return { ok: false, error: res.error };
        // Открыть сразу: оператор ждёт результата, а не ищет файл сам.
        await shell.openPath(savePath).catch(() => undefined);
        return { ok: true, savePath };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /**
   * Мастер печати фотографий на ВСЕ отмеченные снимки сразу.
   *
   * Окно одно: системный мастер умеет печатать набор, если вызвать глагол «Печать»
   * у множественного выделения (как делает Проводник по Ctrl+P). Поэтому снимки
   * копируются во временную папку оператора, и мастер открывается на ней.
   *
   * Дверь ЖДЁТ, пока оператор закроет мастер: возврат — это сигнал «окно закрылось»,
   * по которому программа возвращает фокус и предлагает убрать копии.
   */
  ipcMain.handle(
    'fileSearch:printWizard',
    async (_e, args: { ids?: string[] }): Promise<
      { ok: true; folder: string; mode: 'wizard' | 'explorer' } | { ok: false; error: string; folder?: string }
    > => {
      try {
        const paths = localPathsOf(args?.ids);
        if (paths.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
        const staged = await stageLocalFiles(paths, 'Фото для печати');
        if (!staged.ok) return { ok: false, error: staged.error };
        const copies = staged.files.map((f) => f.path);
        // Тот же общий шаг печати, что у кнопок над отмеченными картинками.
        const res = await printPhotos(copies, { mode: 'os' });
        // Фокус в окно программы: мастер закрыт — оператор вернулся к нам.
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
        if (!res.ok) {
          // Принтера нет — папку с копиями открывать незачем: печатать всё равно нечем.
          if (res.reason === 'no-printers') return { ok: false, error: res.error };
          // Мастер не открылся — показываем папку с копиями, оператор вызовет мастер сам.
          await shell.openPath(staged.folder).catch(() => undefined);
          return {
            ok: false,
            error: `${res.error}. Открыта папка с копиями снимков — вызовите мастер печати вручную (Ctrl+P).`,
            folder: staged.folder,
          };
        }
        return { ok: true, folder: staged.folder, mode: 'wizard' };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /** Открыть папку, где лежат отмеченные файлы (на диске оператора, не на сервере). */
  ipcMain.handle(
    'fileSearch:revealFolder',
    async (_e, args: { ids?: string[] }): Promise<{ ok: true; folder: string } | { ok: false; error: string }> => {
      try {
        const paths = localPathsOf(args?.ids);
        if (paths.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
        const folder = dirname(paths[0] ?? '');
        if (!folder) return { ok: false, error: 'Не удалось определить папку файла' };
        await shell.openPath(folder).catch(() => undefined);
        return { ok: true, folder };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /**
   * Копии отмеченных файлов во временную папку оператора — для почты и отправки.
   *
   * Пути копий «выданы» главным процессом: renderer сможет отдать их обратно
   * (загрузка на сервер, отправка в чат), но не сможет подсунуть произвольный путь.
   */
  ipcMain.handle(
    'fileSearch:stageForShare',
    async (_e, args: { ids?: string[]; label?: string }): Promise<
      { ok: true; folder: string; paths: string[]; names: string[] } | { ok: false; error: string }
    > => {
      try {
        const paths = localPathsOf(args?.ids);
        if (paths.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
        const staged = await stageLocalFiles(paths, String(args?.label || 'Файлы для отправки'));
        if (!staged.ok) return { ok: false, error: staged.error };
        return {
          ok: true,
          folder: staged.folder,
          paths: staged.files.map((f) => f.path),
          names: staged.files.map((f) => f.name),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /** Убрать временные копии (после печати/отправки или по просьбе оператора). */
  ipcMain.handle(
    'fileSearch:cleanupTempFolder',
    async (_e, args: { folder?: string }): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> => {
      try {
        const removed = await removeStagedFolder(String(args?.folder ?? ''));
        return { ok: true, removed };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  /** Скопировать пути отмеченных файлов в буфер обмена. */
  ipcMain.handle(
    'fileSearch:copyPaths',
    async (_e, args: { ids?: string[] }): Promise<{ ok: true; count: number } | { ok: false; error: string }> => {
      try {
        const paths = localPathsOf(args?.ids);
        if (paths.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
        clipboard.writeText(paths.join('\r\n'));
        return { ok: true, count: paths.length };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );
}
