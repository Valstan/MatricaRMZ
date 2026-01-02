import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult, requirePermOrThrow } from '../ipcContext.js';

import { listEngines, createEngine, getEngineDetails, setEngineAttribute } from '../../services/engineService.js';
import { listOperations, addOperation } from '../../services/operationService.js';
import { addAudit, listAudit } from '../../services/auditService.js';
import { softDeleteEntity } from '../../services/entityService.js';

export function registerEnginesOpsAuditIpc(ctx: IpcContext) {
  // Engines (read)
  ipcMain.handle('engine:list', async () => {
    await requirePermOrThrow(ctx, 'engines.view');
    return listEngines(ctx.db);
  });
  ipcMain.handle('engine:get', async (_e, id: string) => {
    await requirePermOrThrow(ctx, 'engines.view');
    return getEngineDetails(ctx.db, id);
  });

  // Engines (write)
  ipcMain.handle('engine:create', async () => {
    await requirePermOrThrow(ctx, 'engines.edit');
    return createEngine(ctx.db, await ctx.currentActor());
  });
  ipcMain.handle('engine:setAttr', async (_e, engineId: string, code: string, value: unknown) => {
    await requirePermOrThrow(ctx, 'engines.edit');
    return setEngineAttribute(ctx.db, engineId, code, value, await ctx.currentActor());
  });
  ipcMain.handle('engine:delete', async (_e, engineId: string) => {
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate;
    return softDeleteEntity(ctx.db, engineId);
  });

  // Operations
  ipcMain.handle('ops:list', async (_e, engineId: string) => {
    await requirePermOrThrow(ctx, 'operations.view');
    return listOperations(ctx.db, engineId);
  });
  ipcMain.handle('ops:add', async (_e, engineId: string, operationType: string, status: string, note?: string) => {
    await requirePermOrThrow(ctx, 'operations.edit');
    return addOperation(ctx.db, engineId, operationType, status, note, await ctx.currentActor());
  });

  // Audit
  ipcMain.handle('audit:list', async () => {
    // Audit is currently used mainly for troubleshooting/admin; keep as-is.
    return listAudit(ctx.db);
  });

  ipcMain.handle('audit:add', async (_e, args: { action: string; entityId?: string | null; tableName?: string | null; payload?: unknown }) => {
    try {
      const actor = await ctx.currentActor();
      return await addAudit(ctx.db, { actor, ...args });
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}


