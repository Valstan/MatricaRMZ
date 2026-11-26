import { BrowserWindow, dialog, ipcMain } from 'electron';

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
import { osPrintWizardAvailable, printImagesViaOsWizard } from '../../services/localImagePrint.js';
import { photosPrintLocalPaths } from '../../services/fileService.js';
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
   *  - `dialog` — системный диалог печати Chromium, все картинки сразу;
   *  - `os` — СИСТЕМНЫЙ мастер печати фотографий (то, что владелец назвал
   *    «Microsoft Picture Manager»): оператор в системном окне правит размер
   *    и раскладку и жмёт «Печать». Один файл — одно окно.
   *
   * Если системный мастер не открылся — внятное сообщение и предложение
   * запасного пути «Печать», а не тишина.
   */
  ipcMain.handle(
    'fileSearch:printImages',
    async (_e, args: { ids?: string[]; mode?: 'dialog' | 'os' }): Promise<
      { ok: true; opened?: number; failed?: number } | Err
    > => {
      try {
        const ids = Array.isArray(args?.ids) ? args.ids.slice(0, MAX_FOLDER_MATCHES) : [];
        const paths: string[] = [];
        for (const id of ids) {
          const resolved = resolveImagePath(String(id ?? ''));
          if (resolved) paths.push(resolved.path);
        }
        if (paths.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
        if (args?.mode === 'os') {
          const result = await printImagesViaOsWizard(paths);
          if (!result.ok) return { ok: false, error: result.error };
          return { ok: true, opened: result.opened, failed: result.failed };
        }
        return await photosPrintLocalPaths(paths);
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
}
