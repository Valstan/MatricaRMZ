import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { httpAuthed } from '../../services/httpClient.js';
import {
  deleteWorkSheetRow,
  getWorkSheetRow,
  listWorkSheetRows,
  saveWorkSheetRow,
  searchWorkSheetRows,
  type SaveWorkSheetRowInput,
} from '../../services/workSheetService.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

function toResult<T>(r: { ok: boolean; status: number; json?: unknown; text?: string }): Result<T> {
  if (r.ok && r.json && typeof r.json === 'object') return r.json as Result<T>;
  if (r.ok) return { ok: true } as Ok<T>;
  const errPayload = r.json as { error?: unknown } | null;
  const msg = (errPayload && typeof errPayload.error === 'string' ? errPayload.error : r.text) || `HTTP ${r.status}`;
  return { ok: false, error: String(msg) };
}

/**
 * Виды работ — серверный справочник этапов работ: живут только на сервере, REST
 * `/work-sheet-types`, как приказы о ценах. Строки этапов работ — записи истории ремонта в
 * `operations`, они синхронизируются обычным путём (см. `workSheetService`, PR-B3).
 * Читать — `operations.view` (то же право, что у истории, входит в базу оператора).
 * Писать — два отдельных поимённых права (решение владельца 15.09.2026): строки —
 * `work_sheets.edit`, виды работ — `work_sheet_types.edit`. Роль их не даёт даже admin'у,
 * а `operations.edit` есть у мастеров и бригадиров — на нём «остальным только смотреть»
 * не держится.
 */
export function registerWorkSheetsIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle('workSheets:types:list', async (_e, args?: { includeArchived?: boolean }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as Err;
    const qs = args?.includeArchived ? '?includeArchived=1' : '';
    return toResult(await httpAuthed(ctx.sysDb, base(), `/work-sheet-types${qs}`, { method: 'GET' }));
  });

  ipcMain.handle(
    'workSheets:types:upsert',
    async (
      _e,
      args: {
        id?: string;
        code?: string;
        name: string;
        workshopId?: string | null;
        completesRepair?: boolean;
        columns?: unknown[];
        sortOrder?: number;
        expectedUpdatedAt?: number;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'work_sheet_types.edit');
      if (!gate.ok) return gate as Err;
      return toResult(
        await httpAuthed(ctx.sysDb, base(), '/work-sheet-types', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }),
      );
    },
  );

  ipcMain.handle('workSheets:types:archive', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_sheet_types.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/work-sheet-types/${encodeURIComponent(id)}/archive`, { method: 'POST' }));
  });

  ipcMain.handle('workSheets:types:restore', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_sheet_types.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/work-sheet-types/${encodeURIComponent(id)}/restore`, { method: 'POST' }));
  });
  // Строки — записи истории ремонта в локальной реплике: читаются и пишутся без сервера,
  // уезжают обычным синком. Чтение — `operations.view`, запись — `work_sheets.edit` (см. шапку);
  // серверный гейт синка требует то же право для строк этапов работ (`ledgerAuthz`).
  ipcMain.handle('workSheets:rows:list', async (_e, args?: { sinceMs?: number | null; typeCode?: string | null }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as Err;
    try {
      return { ok: true as const, ...(await listWorkSheetRows(ctx.dataDb(), args ?? {})) };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  // Ctrl+K. Имя канала начинается с `workSheets:` не для красоты: по этому префиксу
  // секционный гейт требует раздел «Производство» (sectionGate). Канал `search:*` жил бы
  // вне гейта, и палитра стала бы обходом раздела.
  ipcMain.handle('workSheets:rows:search', async (_e, args: { q: string; limit?: number }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as Err;
    return await searchWorkSheetRows(ctx.dataDb(), args ?? { q: '' });
  });

  ipcMain.handle('workSheets:rows:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as Err;
    try {
      const row = await getWorkSheetRow(ctx.dataDb(), id);
      return row ? { ok: true as const, row } : { ok: false as const, error: 'Этап работ не найден' };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('workSheets:rows:save', async (_e, args: SaveWorkSheetRowInput) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_sheets.edit');
    if (!gate.ok) return gate as Err;
    try {
      return await saveWorkSheetRow(ctx.dataDb(), args, await ctx.currentActor());
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('workSheets:rows:delete', async (_e, id: string, opts?: { rollbackRepair?: boolean }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_sheets.edit');
    if (!gate.ok) return gate as Err;
    try {
      return await deleteWorkSheetRow(ctx.dataDb(), id, opts ?? {}, await ctx.currentActor());
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}
