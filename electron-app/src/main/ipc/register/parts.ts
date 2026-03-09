import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult } from '../ipcContext.js';

import {
  partTemplatesCreate,
  partTemplatesDelete,
  partTemplatesGet,
  partTemplatesList,
  partTemplatesUpdateAttribute,
  partsBrandLinksDelete,
  partsBrandLinksList,
  partsBrandLinksUpsert,
  partsCreate,
  partsCreateFromTemplate,
  partsCreateAttributeDef,
  partsDelete,
  partsGet,
  partsGetFiles,
  partsList,
  partsUpdateAttribute,
} from '../../services/partsService.js';

export function registerPartsIpc(ctx: IpcContext) {
  ipcMain.handle('parts:list', async (_e, args?: { q?: string; limit?: number; offset?: number; engineBrandId?: string; templateId?: string }) => {
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

  ipcMain.handle('parts:templates:list', async (_e, args?: { q?: string; limit?: number; offset?: number }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.view');
    if (!gate.ok) return gate as any;
    return partTemplatesList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:templates:get', async (_e, templateId: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.view');
    if (!gate.ok) return gate as any;
    return partTemplatesGet(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { templateId });
  });

  ipcMain.handle('parts:templates:create', async (_e, args?: { attributes?: Record<string, unknown> }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.create');
    if (!gate.ok) return gate as any;
    return partTemplatesCreate(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:templates:updateAttribute', async (_e, args: { templateId: string; attributeCode: string; value: unknown }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.edit');
    if (!gate.ok) return gate as any;
    return partTemplatesUpdateAttribute(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:templates:delete', async (_e, templateId: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.delete');
    if (!gate.ok) return gate as any;
    return partTemplatesDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { templateId });
  });

  ipcMain.handle('parts:createFromTemplate', async (_e, args: { templateId: string; attributes?: Record<string, unknown> }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.create');
    if (!gate.ok) return gate as any;
    return partsCreateFromTemplate(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:updateAttribute', async (_e, args: { partId: string; attributeCode: string; value: unknown }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.edit');
    if (!gate.ok) return gate as any;
    return partsUpdateAttribute(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:partBrandLinks:list', async (_e, args: { partId?: string; engineBrandId?: string }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.view');
    if (!gate.ok) return gate as any;
    return partsBrandLinksList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle(
    'parts:partBrandLinks:upsert',
    async (
      _e,
      args: {
        partId: string;
        linkId?: string;
        engineBrandId: string;
        assemblyUnitNumber: string;
        quantity: number;
      },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
      const gate = await requirePermOrResult(ctx, 'parts.edit');
      if (!gate.ok) return gate as any;
      return partsBrandLinksUpsert(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('parts:partBrandLinks:delete', async (_e, args: { partId: string; linkId: string }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: parts are not available (server sync disabled)' };
    const gate = await requirePermOrResult(ctx, 'parts.edit');
    if (!gate.ok) return gate as any;
    return partsBrandLinksDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
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


