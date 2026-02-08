import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { authStatus } from '../../services/authService.js';

import {
  createSupplyRequest,
  deleteSupplyRequest,
  getSupplyRequest,
  listSupplyRequests,
  transitionSupplyRequest,
  updateSupplyRequest,
} from '../../services/supplyRequestService.js';

export function registerSupplyRequestsIpc(ctx: IpcContext) {
  async function getScope() {
    const auth = await authStatus(ctx.sysDb);
    if (!auth.loggedIn || !auth.user) return null;
    return { userId: auth.user.id, role: auth.user.role };
  }

  ipcMain.handle('supplyRequests:list', async (_e, args?: { q?: string; month?: string }) => {
    const gate = await requirePermOrResult(ctx, 'supply_requests.view');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return listSupplyRequests(ctx.dataDb(), args, scope);
  });

  ipcMain.handle('supplyRequests:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'supply_requests.view');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return getSupplyRequest(ctx.dataDb(), id, scope);
  });

  ipcMain.handle('supplyRequests:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'supply_requests.create');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return createSupplyRequest(ctx.dataDb(), await ctx.currentActor(), scope);
  });

  ipcMain.handle('supplyRequests:update', async (_e, args: { id: string; payload: any }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'supply_requests.edit');
    if (!gate.ok) return gate as any;
    const actor = await ctx.currentActor();
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return updateSupplyRequest(ctx.dataDb(), { id: args.id, payload: args.payload, actor, scope });
  });

  ipcMain.handle('supplyRequests:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'supply_requests.edit');
    if (!gate.ok) return gate as any;
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    const actor = await ctx.currentActor();
    return deleteSupplyRequest(ctx.dataDb(), { id, actor, scope });
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
    const scope = await getScope();
    if (!scope) return { ok: false as const, error: 'missing user session' };
    return transitionSupplyRequest(ctx.dataDb(), { id: args.id, action: action as any, actor, note: args.note ?? null, scope });
  });
}


