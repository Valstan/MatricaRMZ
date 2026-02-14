import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import {
  createWorkOrder,
  deleteWorkOrder,
  getWorkOrder,
  listWorkOrders,
  updateWorkOrder,
} from '../../services/workOrderService.js';

export function registerWorkOrdersIpc(ctx: IpcContext) {
  ipcMain.handle('workOrders:list', async (_e, args?: { q?: string; month?: string }) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.view');
    if (!gate.ok) return gate as any;
    return listWorkOrders(ctx.dataDb(), args);
  });

  ipcMain.handle('workOrders:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.view');
    if (!gate.ok) return gate as any;
    return getWorkOrder(ctx.dataDb(), id);
  });

  ipcMain.handle('workOrders:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.create');
    if (!gate.ok) return gate as any;
    return createWorkOrder(ctx.dataDb(), await ctx.currentActor());
  });

  ipcMain.handle('workOrders:update', async (_e, args: { id: string; payload: any }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.edit');
    if (!gate.ok) return gate as any;
    return updateWorkOrder(ctx.dataDb(), { id: args.id, payload: args.payload, actor: await ctx.currentActor() });
  });

  ipcMain.handle('workOrders:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.edit');
    if (!gate.ok) return gate as any;
    return deleteWorkOrder(ctx.dataDb(), { id, actor: await ctx.currentActor() });
  });
}

