import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult } from '../ipcContext.js';
import { erpCardsList, erpCardsUpsert, erpDictionaryList, erpDictionaryUpsert, erpDocumentsCreate, erpDocumentsList, erpDocumentsPost } from '../../services/erpService.js';

export function registerErpIpc(ctx: IpcContext) {
  ipcMain.handle('erp:dictionary:list', async (_e, moduleName: 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees') => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp dictionary is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return erpDictionaryList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), moduleName);
  });

  ipcMain.handle(
    'erp:dictionary:upsert',
    async (
      _e,
      args: {
        moduleName: 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees';
        id?: string;
        code: string;
        name: string;
        payloadJson?: string | null;
      },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp dictionary is not available' };
      const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
      if (!gate.ok) return gate as any;
      return erpDictionaryUpsert(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('erp:cards:list', async (_e, moduleName: 'parts' | 'tools' | 'employees') => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp cards are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.cards.view');
    if (!gate.ok) return gate as any;
    return erpCardsList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), moduleName);
  });

  ipcMain.handle(
    'erp:cards:upsert',
    async (
      _e,
      args: {
        moduleName: 'parts' | 'tools' | 'employees';
        id?: string;
        templateId?: string | null;
        serialNo?: string | null;
        cardNo?: string | null;
        status?: string | null;
        payloadJson?: string | null;
        fullName?: string | null;
        personnelNo?: string | null;
        roleCode?: string | null;
      },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp cards are not available' };
      const gate = await requirePermOrResult(ctx, 'erp.cards.edit');
      if (!gate.ok) return gate as any;
      return erpCardsUpsert(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('erp:documents:list', async (_e, args?: { status?: string; docType?: string }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp documents are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.documents.view');
    if (!gate.ok) return gate as any;
    return erpDocumentsList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle(
    'erp:documents:create',
    async (
      _e,
      args: {
        docType: string;
        docNo: string;
        docDate?: number;
        departmentId?: string | null;
        authorId?: string | null;
        payloadJson?: string | null;
        lines: Array<{ partCardId?: string | null; qty: number; price?: number | null; payloadJson?: string | null }>;
      },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp documents are not available' };
      const gate = await requirePermOrResult(ctx, 'erp.documents.edit');
      if (!gate.ok) return gate as any;
      return erpDocumentsCreate(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('erp:documents:post', async (_e, documentId: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp documents are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.documents.post');
    if (!gate.ok) return gate as any;
    return erpDocumentsPost(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(documentId || ''));
  });
}
