import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, requirePermOrThrow, viewModeWriteError } from '../ipcContext.js';

import { listEngines, createEngine, getEngineDetails, setEngineAttribute } from '../../services/engineService.js';
import { listOperations, addOperation } from '../../services/operationService.js';
import { addAudit, listAudit } from '../../services/auditService.js';
import { softDeleteEntity } from '../../services/entityService.js';

export function registerEnginesOpsAuditIpc(ctx: IpcContext) {
  // Engines (read)
  ipcMain.handle('engine:list', async () => {
    await requirePermOrThrow(ctx, 'engines.view');
    return listEngines(ctx.dataDb());
  });
  ipcMain.handle('engine:get', async (_e, id: string) => {
    await requirePermOrThrow(ctx, 'engines.view');
    return getEngineDetails(ctx.dataDb(), id);
  });

  // Engines (write)
  ipcMain.handle('engine:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    await requirePermOrThrow(ctx, 'engines.edit');
    return createEngine(ctx.dataDb(), await ctx.currentActor());
  });
  ipcMain.handle('engine:setAttr', async (_e, engineId: string, code: string, value: unknown) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    await requirePermOrThrow(ctx, 'engines.edit');
    return setEngineAttribute(ctx.dataDb(), engineId, code, value, await ctx.currentActor());
  });
  ipcMain.handle('engine:delete', async (_e, engineId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate;
    return softDeleteEntity(ctx.dataDb(), engineId);
  });

  // Operations
  ipcMain.handle('ops:list', async (_e, engineId: string) => {
    await requirePermOrThrow(ctx, 'operations.view');
    return listOperations(ctx.dataDb(), engineId);
  });
  ipcMain.handle('ops:add', async (_e, engineId: string, operationType: string, status: string, note?: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    await requirePermOrThrow(ctx, 'operations.edit');
    return addOperation(ctx.dataDb(), engineId, operationType, status, note, await ctx.currentActor());
  });

  // Audit
  ipcMain.handle('audit:list', async () => {
    // Audit is currently used mainly for troubleshooting/admin; keep as-is.
    return listAudit(ctx.dataDb());
  });

  ipcMain.handle('audit:add', async (_e, args: { action: string; entityId?: string | null; tableName?: string | null; payload?: unknown }) => {
    try {
      if (isViewMode(ctx)) return viewModeWriteError();
      const actor = await ctx.currentActor();
      return await addAudit(ctx.dataDb(), { actor, ...args });
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}


