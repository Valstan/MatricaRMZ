import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult } from '../ipcContext.js';

import { partsCreate, partsCreateAttributeDef, partsDelete, partsGet, partsGetFiles, partsList, partsUpdateAttribute } from '../../services/partsService.js';

export function registerPartsIpc(ctx: IpcContext) {
  ipcMain.handle('parts:list', async (_e, args?: { q?: string; limit?: number }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.view');
    if (!gate.ok) return gate as any;
    return partsList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:get', async (_e, partId: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.view');
    if (!gate.ok) return gate as any;
    return partsGet(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { partId });
  });

  ipcMain.handle('parts:create', async (_e, args?: { attributes?: Record<string, unknown> }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.create');
    if (!gate.ok) return gate as any;
    return partsCreate(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:updateAttribute', async (_e, args: { partId: string; attributeCode: string; value: unknown }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.edit');
    if (!gate.ok) return gate as any;
    return partsUpdateAttribute(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle(
    'parts:attributeDefCreate',
    async (
      _e,
      args: {
        code: string;
        name: string;
        dataType: 'text' | 'number' | 'boolean' | 'date' | 'json' | 'link';
        isRequired?: boolean;
        sortOrder?: number;
        metaJson?: string | null;
      },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
      const gate = await requirePermOrResult(ctx, 'parts.edit');
      if (!gate.ok) return gate as any;
      return partsCreateAttributeDef(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('parts:delete', async (_e, partId: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.delete');
    if (!gate.ok) return gate as any;
    return partsDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { partId });
  });

  ipcMain.handle('parts:getFiles', async (_e, partId: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.view');
    if (!gate.ok) return gate as any;
    return partsGetFiles(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { partId });
  });
}


