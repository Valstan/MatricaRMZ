import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { httpAuthed } from '../../services/httpClient.js';

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
 * Узлы ведомостей работ (справочник видов ведомостей) живут только на сервере — REST
 * `/work-sheet-types`, как приказы о ценах. Строки ведомостей — записи истории ремонта в
 * `operations`, они синхронизируются обычным путём (см. `workSheetService`, PR-B3).
 * Читать — `operations.view` (то же право, что у истории), заводить узлы — `erp.dictionary.edit`.
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
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
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
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/work-sheet-types/${encodeURIComponent(id)}/archive`, { method: 'POST' }));
  });

  ipcMain.handle('workSheets:types:restore', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/work-sheet-types/${encodeURIComponent(id)}/restore`, { method: 'POST' }));
  });
}
