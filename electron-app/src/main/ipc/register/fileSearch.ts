import { BrowserWindow, dialog, ipcMain } from 'electron';

import {
  FILE_SEARCH_DIALOG_FILTERS,
  type FileSearchResult,
  type FileSearchSource,
} from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';
import { findEngineByExactNumber, listEngineCharacteristicDefs } from '../../services/engineExactLookupService.js';
import {
  SEARCH_SOURCE_EXTENSIONS,
  describeSearchSource,
  readSearchContext,
  searchFileSources,
  sourceIdForPath,
} from '../../services/fileSearchService.js';
import { SettingsKey, settingsGetString, settingsSetString } from '../../services/settingsStore.js';

type Err = { ok: false; error: string };

const MAX_SOURCES = 50;

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
}
