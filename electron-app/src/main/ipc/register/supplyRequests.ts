import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';

import {
  createSupplyRequest,
  deleteSupplyRequest,
  getSupplyRequest,
  listSupplyRequests,
  transitionSupplyRequest,
  updateSupplyRequest,
} from '../../services/supplyRequestService.js';

export function registerSupplyRequestsIpc(ctx: IpcContext) {
  ipcMain.handle('supplyRequests:list', async (_e, args?: { q?: string; month?: string }) => {
    const gate = await requirePermOrResult(ctx, 'supply_requests.view');
    if (!gate.ok) return gate as any;
    return listSupplyRequests(ctx.dataDb(), args);
  });

  ipcMain.handle('supplyRequests:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'supply_requests.view');
    if (!gate.ok) return gate as any;
    return getSupplyRequest(ctx.dataDb(), id);
  });

  ipcMain.handle('supplyRequests:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'supply_requests.create');
    if (!gate.ok) return gate as any;
    return createSupplyRequest(ctx.dataDb(), await ctx.currentActor());
  });

  ipcMain.handle('supplyRequests:update', async (_e, args: { id: string; payload: any }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'supply_requests.edit');
    if (!gate.ok) return gate as any;
    const actor = await ctx.currentActor();
    return updateSupplyRequest(ctx.dataDb(), { id: args.id, payload: args.payload, actor });
  });

  ipcMain.handle('supplyRequests:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'supply_requests.edit');
    if (!gate.ok) return gate as any;
    return deleteSupplyRequest(ctx.dataDb(), id);
  });

  ipcMain.handle('supplyRequests:transition', async (_e, args: { id: string; action: string; note?: string | null }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const action = String(args.action);
    const required =
      action === 'sign'
        ? 'supply_requests.sign'
        : action === 'director_approve'
          ? 'supply_requests.director_approve'
          : action === 'accept'
            ? 'supply_requests.accept'
            : action === 'fulfill_full' || action === 'fulfill_partial'
              ? 'supply_requests.fulfill'
              : null;

    if (!required) return { ok: false, error: `unknown action: ${action}` };

    const gate = await requirePermOrResult(ctx, required);
    if (!gate.ok) return gate as any;

    const actor = await ctx.currentActor();
    return transitionSupplyRequest(ctx.dataDb(), { id: args.id, action: action as any, actor, note: args.note ?? null });
  });
}


