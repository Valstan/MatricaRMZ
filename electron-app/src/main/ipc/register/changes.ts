import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';

import { changesApply, changesList, changesReject } from '../../services/changesService.js';

export function registerChangesIpc(ctx: IpcContext) {
  ipcMain.handle('changes:list', async (_e, args?: { status?: string; limit?: number }) => {
    const gate = await requirePermOrResult(ctx, 'updates.use');
    if (!gate.ok) return gate as any;
    return changesList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('changes:apply', async (_e, args: { id: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'updates.use');
    if (!gate.ok) return gate as any;
    return changesApply(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args.id);
  });

  ipcMain.handle('changes:reject', async (_e, args: { id: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'updates.use');
    if (!gate.ok) return gate as any;
    return changesReject(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args.id);
  });
}


