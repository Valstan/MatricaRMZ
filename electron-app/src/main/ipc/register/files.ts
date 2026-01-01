import { ipcMain, dialog, app } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';

import { filesDelete, filesDownload, filesDownloadDirGet, filesDownloadDirSet, filesOpen, filesPreviewGet, filesUpload } from '../../services/fileService.js';

export function registerFilesIpc(ctx: IpcContext) {
  ipcMain.handle('files:upload', async (_e, args: { path: string; scope?: { ownerType: string; ownerId: string; category: string } }) => {
    const gate = await requirePermOrResult(ctx, 'files.upload');
    if (!gate.ok) return gate;
    return filesUpload(ctx.db, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('files:pick', async () => {
    try {
      const gate = await requirePermOrResult(ctx, 'files.upload');
      if (!gate.ok) return gate;

      const r = await dialog.showOpenDialog({
        title: 'Выберите файлы для загрузки',
        properties: ['openFile', 'multiSelections'],
      });
      const paths = (r.filePaths ?? []).map((p) => String(p)).filter(Boolean);
      if (paths.length === 0) return { ok: false, error: 'cancelled' };
      return { ok: true, paths };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('files:downloadDir:get', async () => {
    return filesDownloadDirGet(ctx.db, { defaultDir: app.getPath('downloads') });
  });

  ipcMain.handle('files:downloadDir:pick', async () => {
    try {
      const gate = await requirePermOrResult(ctx, 'files.view');
      if (!gate.ok) return gate;

      const r = await dialog.showOpenDialog({
        title: 'Выберите папку для скачивания файлов',
        properties: ['openDirectory', 'createDirectory'],
      });
      const p = r.filePaths?.[0] ? String(r.filePaths[0]) : '';
      if (!p) return { ok: false, error: 'cancelled' };
      return await filesDownloadDirSet(ctx.db, p);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('files:download', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.db, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return filesDownload(ctx.db, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path });
  });

  ipcMain.handle('files:open', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.db, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return filesOpen(ctx.db, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path });
  });

  ipcMain.handle('files:delete', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.delete');
    if (!gate.ok) return gate;
    return filesDelete(ctx.db, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId });
  });

  ipcMain.handle('files:preview:get', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    return filesPreviewGet(ctx.db, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId });
  });
}


