import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { authStatus } from '../../services/authService.js';
import {
  addToolMovement,
  createToolCatalogItem,
  createTool,
  createToolProperty,
  deleteTool,
  deleteToolProperty,
  exportToolCardPdf,
  getTool,
  getToolProperty,
  listEmployeesForTools,
  getToolsScope,
  listToolCatalog,
  listToolMovements,
  listToolPropertyValueHints,
  listToolProperties,
  listTools,
  setToolAttribute,
  setToolPropertyAttribute,
} from '../../services/toolsService.js';

export function registerToolsIpc(ctx: IpcContext) {
  async function getScope() {
    const auth = await authStatus(ctx.sysDb);
    if (!auth.loggedIn || !auth.user) return null;
    return { userId: auth.user.id, role: auth.user.role };
  }

  ipcMain.handle('tools:list', async (_e, args?: { q?: string }) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return listTools(ctx.dataDb(), args, scope);
  });

  ipcMain.handle('tools:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return getTool(ctx.dataDb(), id, scope);
  });

  ipcMain.handle('tools:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return createTool(ctx.dataDb(), await ctx.currentActor(), scope);
  });

  ipcMain.handle('tools:setAttr', async (_e, args: { toolId: string; code: string; value: unknown }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return setToolAttribute(ctx.dataDb(), { ...args, scope });
  });

  ipcMain.handle('tools:delete', async (_e, toolId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return deleteTool(ctx.dataDb(), { toolId, scope });
  });

  ipcMain.handle('tools:movements:list', async (_e, toolId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return listToolMovements(ctx.dataDb(), toolId, scope);
  });

  ipcMain.handle(
    'tools:movements:add',
    async (
      _e,
      args: {
        toolId: string;
        movementAt: number;
        mode: 'received' | 'returned';
        employeeId?: string | null;
        confirmed?: boolean;
        confirmedById?: string | null;
        comment?: string | null;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'masterdata.edit');
      if (!gate.ok) return gate as any;
      const scope = await getScope();
      if (!scope) return { ok: false as const, error: 'missing user session' };
      const actor = await ctx.currentActor();
      return addToolMovement(ctx.dataDb(), { ...args, actor, scope });
    },
  );

  ipcMain.handle('tools:exportPdf', async (_e, toolId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return exportToolCardPdf(ctx.dataDb(), { toolId, scope });
  });

  ipcMain.handle('tools:properties:list', async () => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    return listToolProperties(ctx.dataDb());
  });

  ipcMain.handle('tools:properties:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    return getToolProperty(ctx.dataDb(), id);
  });

  ipcMain.handle('tools:properties:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return createToolProperty(ctx.dataDb());
  });

  ipcMain.handle('tools:properties:setAttr', async (_e, args: { id: string; code: string; value: unknown }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return setToolPropertyAttribute(ctx.dataDb(), args);
  });

  ipcMain.handle('tools:properties:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return deleteToolProperty(ctx.dataDb(), id);
  });

  ipcMain.handle('tools:properties:valueHints', async (_e, propertyId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return listToolPropertyValueHints(ctx.dataDb(), { propertyId, scope });
  });

  ipcMain.handle('tools:catalog:list', async () => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    return listToolCatalog(ctx.dataDb());
  });

  ipcMain.handle('tools:catalog:create', async (_e, args: { name: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return createToolCatalogItem(ctx.dataDb(), args.name);
  });

  ipcMain.handle('tools:scope', async () => {
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return getToolsScope(ctx.dataDb(), scope);
  });

  ipcMain.handle('tools:employees:list', async (_e, args?: { departmentId?: string | null }) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    return listEmployeesForTools(ctx.dataDb(), args?.departmentId ?? null);
  });
}
