import { join } from 'node:path';

import { ipcMain, dialog, app, BrowserWindow } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { consumeIssuedPath, rememberIssuedPath } from '../pathOriginRegistry.js';

import {
  filesCopyImageToClipboard,
  filesCopyToFolder,
  filesDelete,
  filesDownload,
  filesDownloadDirGet,
  filesDownloadDirSet,
  filesOpen,
  filesOriginalGet,
  filesPreviewGet,
  filesRevealForShare,
  filesUpload,
  photosAssemblePdf,
  photosPrint,
} from '../../services/fileService.js';

export function registerFilesIpc(ctx: IpcContext) {
  ipcMain.handle('files:upload', async (_e, args: { path: string; fileName?: string; scope?: { ownerType: string; ownerId: string; category: string } }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'files.upload');
    if (!gate.ok) return gate;
    if (!consumeIssuedPath(args?.path)) return { ok: false as const, error: 'путь не из диалога выбора файлов' };
    return filesUpload(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('files:pick', async () => {
    try {
      const gate = await requirePermOrResult(ctx, 'files.upload');
      if (!gate.ok) return gate;

      const parent = BrowserWindow.getFocusedWindow();
      const opts = { title: 'Выберите файлы для загрузки', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      const paths = (r.filePaths ?? []).map((p) => String(p)).filter(Boolean);
      if (paths.length === 0) return { ok: false, error: 'cancelled' };
      for (const p of paths) rememberIssuedPath(p);
      return { ok: true, paths };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('files:downloadDir:get', async () => {
    return filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
  });

  ipcMain.handle('files:downloadDir:pick', async () => {
    try {
      const gate = await requirePermOrResult(ctx, 'files.view');
      if (!gate.ok) return gate;

      const dirParent = BrowserWindow.getFocusedWindow();
      const dirOpts = { title: 'Выберите папку для скачивания файлов', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
      const r = dirParent ? await dialog.showOpenDialog(dirParent, dirOpts) : await dialog.showOpenDialog(dirOpts);
      const p = r.filePaths?.[0] ? String(r.filePaths[0]) : '';
      if (!p) return { ok: false, error: 'cancelled' };
      return await filesDownloadDirSet(ctx.sysDb, p);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('files:download', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    const result = await filesDownload(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path });
    // Allowlist the main-generated path so a downloaded file can be re-shared via
    // chat:sendFile without a fresh dialog (App.tsx note→chat re-share flow).
    if ((result as { ok?: boolean; localPath?: string })?.ok && (result as { localPath?: string }).localPath) {
      rememberIssuedPath(String((result as { localPath?: string }).localPath));
    }
    return result;
  });

  ipcMain.handle('files:open', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return filesOpen(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path });
  });

  ipcMain.handle('files:delete', async (_e, args: { fileId: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'files.delete');
    if (!gate.ok) return gate;
    return filesDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId });
  });

  ipcMain.handle('files:preview:get', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    return filesPreviewGet(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId });
  });

  ipcMain.handle('files:original:get', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    // filesOriginalGet returns a base64 dataUrl (no on-disk path exposed to the
    // renderer), so there is nothing to allowlist here.
    return filesOriginalGet(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path });
  });

  ipcMain.handle('files:clipboard:copyImage', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return filesCopyImageToClipboard(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path });
  });

  ipcMain.handle('files:copyToFolder', async (_e, args: { fileIds: string[] }) => {
    try {
      const gate = await requirePermOrResult(ctx, 'files.view');
      if (!gate.ok) return gate;
      const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
      if (!dir.ok) return dir;
      const parent = BrowserWindow.getFocusedWindow();
      const opts = {
        title: 'Куда сохранить копии фото (папка или флешка)',
        defaultPath: app.getPath('desktop'),
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
      };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      const destDir = r.filePaths?.[0] ? String(r.filePaths[0]) : '';
      if (!destDir) return { ok: false, error: 'cancelled' };
      return filesCopyToFolder(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileIds: args.fileIds, downloadDir: dir.path, destDir });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('files:revealForShare', async (_e, args: { fileIds: string[]; label?: string; mailto?: boolean }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return filesRevealForShare(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
      fileIds: args.fileIds,
      downloadDir: dir.path,
      label: String(args.label || 'Фото двигателя'),
      ...(args.mailto ? { mailto: true } : {}),
    });
  });

  ipcMain.handle('files:assemblePdf', async (_e, args: { fileIds: string[]; defaultName?: string }) => {
    try {
      const gate = await requirePermOrResult(ctx, 'files.view');
      if (!gate.ok) return gate;
      const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
      if (!dir.ok) return dir;
      const parent = BrowserWindow.getFocusedWindow();
      const baseName = String(args.defaultName || 'Фото двигателя').replaceAll(/[\\/:*?"<>|]+/g, '_');
      const opts = {
        title: 'Сохранить PDF с фотографиями',
        defaultPath: join(app.getPath('desktop'), `${baseName}.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      };
      const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
      const savePath = r.canceled || !r.filePath ? '' : String(r.filePath);
      if (!savePath) return { ok: false, error: 'cancelled' };
      return photosAssemblePdf(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileIds: args.fileIds, downloadDir: dir.path, savePath });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('files:print', async (_e, args: { fileIds: string[] }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return photosPrint(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileIds: args.fileIds, downloadDir: dir.path });
  });
}


