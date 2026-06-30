import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, requirePermOrThrow, viewModeWriteError } from '../ipcContext.js';

import { maintenanceEmptyCardsAnalyze, maintenanceEmptyCardsDelete } from '../../services/erpService.js';

export function registerMaintenanceIpc(ctx: IpcContext) {
  // Empty-card cleanup: analyze is read-only (masterdata.view), delete is destructive
  // soft-delete on the server (masterdata.edit). Both run a full authoritative server scan.
  ipcMain.handle('maintenance:emptyCards:analyze', async () => {
    await requirePermOrThrow(ctx, 'masterdata.view');
    return maintenanceEmptyCardsAnalyze(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });
  ipcMain.handle('maintenance:emptyCards:delete', async (_e, args: { ids: string[] }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate;
    return maintenanceEmptyCardsDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
      ids: Array.isArray(args?.ids) ? args.ids.map(String) : [],
    });
  });
}
