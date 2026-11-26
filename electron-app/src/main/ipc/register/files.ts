import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ipcMain, dialog, app, BrowserWindow, shell } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { consumeIssuedPath, rememberIssuedPath } from '../pathOriginRegistry.js';

import { PASTABLE_FILE_DIALOG_FILTERS } from '@matricarmz/shared';

import {
  filesClipboardRead,
  filesClipboardText,
  filesCopyImageToClipboard,
  filesCopyToFolder,
  filesDelete,
  filesDownload,
  filesDownloadDirGet,
  filesDownloadDirSet,
  filesMeta,
  filesOpen,
  filesOpenObjectDir,
  filesOriginalGet,
  filesPreviewGet,
  filesReadPastableText,
  filesRevealForShare,
  filesStageForShare,
  filesUpload,
  photosAssemblePdf,
  photosPrint,
} from '../../services/fileService.js';
import { listFileTransfers } from '../../services/fileTransferProgress.js';
import { printPhotos } from '../../services/photoPrint.js';

export function registerFilesIpc(ctx: IpcContext) {
  ipcMain.handle('files:upload', async (_e, args: { path: string; fileName?: string; scope?: { ownerType: string; ownerId: string; category: string }; transferId?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'files.upload');
    if (!gate.ok) return gate;
    if (!consumeIssuedPath(args?.path)) return { ok: false as const, error: 'путь не из диалога выбора файлов' };
    return filesUpload(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  // Текущие передачи файлов — окну, которое открылось посреди операции (иначе полосы
  // не будет у того окна, которое открыли после старта загрузки).
  ipcMain.handle('files:progress:list', async () => listFileTransfers());

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

  // Файлы, брошенные мышью на карточку. Пути приходят из webUtils.getPathForFile
  // (preload) — их даёт только НАСТОЯЩИЙ File из события drop/paste, поэтому
  // allowlist путей остаётся смыслом: сфабриковать произвольный путь renderer'у нечем.
  ipcMain.handle('files:registerDropped', async (_e, args: { paths: string[] }) => {
    try {
      const gate = await requirePermOrResult(ctx, 'files.upload');
      if (!gate.ok) return gate;

      const paths = (args?.paths ?? []).map((p) => String(p || '').trim()).filter((p) => p.length > 0 && existsSync(p));
      if (paths.length === 0) return { ok: false, error: 'Перетащите файлы (папки так не загружаются)' };
      for (const p of paths) rememberIssuedPath(p);
      return { ok: true, paths };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('files:clipboardRead', async () => {
    const gate = await requirePermOrResult(ctx, 'files.upload');
    if (!gate.ok) return gate;
    const r = await filesClipboardRead();
    if (!r.ok) return r;
    for (const p of r.paths) rememberIssuedPath(p);
    return r;
  });

  // Права не спрашиваем осознанно: это буфер обмена самого оператора и файл, который он
  // сам выбрал в диалоге, а текст едет в поле, куда он и так может печатать с клавиатуры.
  // Запись значения гейтится там, где ей и место, — правом правки карточки.
  ipcMain.handle('files:clipboardText', async () => filesClipboardText());

  ipcMain.handle('files:pickText', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow();
      const opts = {
        title: 'Выберите файл с текстом',
        properties: ['openFile'] as 'openFile'[],
        filters: PASTABLE_FILE_DIALOG_FILTERS,
      };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      const picked = r.filePaths?.[0] ? String(r.filePaths[0]) : '';
      if (!picked) return { ok: false, error: 'cancelled' };
      return await filesReadPastableText(picked);
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

  ipcMain.handle('files:meta', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    return await filesMeta(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileId: args?.fileId ?? '' });
  });

  ipcMain.handle('files:download', async (_e, args: { fileId: string; transferId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    const result = await filesDownload(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path, transferId: args.transferId });
    // Allowlist the main-generated path so a downloaded file can be re-shared via
    // chat:sendFile without a fresh dialog (App.tsx note→chat re-share flow).
    if ((result as { ok?: boolean; localPath?: string })?.ok && (result as { localPath?: string }).localPath) {
      rememberIssuedPath(String((result as { localPath?: string }).localPath));
    }
    return result;
  });

  ipcMain.handle('files:open', async (_e, args: { fileId: string; transferId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return filesOpen(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path, transferId: args.transferId });
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

  ipcMain.handle('files:copyToFolder', async (_e, args: { fileIds: string[]; transferId?: string }) => {
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
      return filesCopyToFolder(ctx.sysDb, ctx.mgr.getApiBaseUrl(), { fileIds: args.fileIds, downloadDir: dir.path, destDir, transferId: args.transferId });
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

  /**
   * Собрать серверные файлы в папку с человеческими именами и выдать пути к копиям.
   *
   * Отличие от `files:revealForShare`: папка не открывается, а пути к копиям
   * возвращаются — их потом можно отдать почте, чату и ИИванычу (все три умеют
   * работать только с ПУТЁМ, который выдал главный процесс). Право — то же
   * (`files.view`), и проверку доступа файла делает сервер при скачивании.
   */
  ipcMain.handle('files:stageForShare', async (_e, args: { fileIds: string[]; label?: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    const r = await filesStageForShare(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
      fileIds: (Array.isArray(args?.fileIds) ? args.fileIds : []).map((id) => String(id ?? '')).filter(Boolean),
      downloadDir: dir.path,
      label: String(args?.label || 'Файлы'),
    });
    if (!r.ok) return r;
    // Копии объявлены «выданными»: renderer сможет отдать их почте/чату/ИИ, но не
    // сможет подсунуть свой путь (allowlist путей, см. `pathOriginRegistry`).
    for (const f of r.files) rememberIssuedPath(f.path);
    return r;
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

  ipcMain.handle('files:openObjectDir', async (_e, args: { fileIds: string[]; label?: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return filesOpenObjectDir(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
      fileIds: args.fileIds,
      downloadDir: dir.path,
      label: String(args.label || 'Карточка'),
    });
  });

  ipcMain.handle('files:print', async (_e, args: { fileIds: string[]; listHtml?: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return photosPrint(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
      fileIds: args.fileIds,
      downloadDir: dir.path,
      ...(typeof args.listHtml === 'string' && args.listHtml ? { listHtml: args.listHtml } : {}),
    });
  });

  /**
   * Мастер печати фотографий для ВЛОЖЕНИЙ карточки (промт КАРМАНА #159 + #160).
   *
   * Вложение карточки лежит на СЕРВЕРЕ, а мастеру печати нужен файл на диске
   * оператора. Поэтому шаг тот же, что у «Поиска по файлам»: серверные файлы
   * скачиваются и копируются во временную папку с ЧЕЛОВЕЧЕСКИМИ именами, и уже
   * копии уходят в мастер — тем же общим шагом печати (`photoPrint.ts`).
   *
   * Дверь ЖДЁТ, пока оператор закроет мастер: возврат — сигнал «окно закрылось»,
   * по которому программа возвращает фокус и предлагает убрать копии.
   */
  ipcMain.handle('files:printWizard', async (_e, args: { fileIds: string[]; label?: string }) => {
    try {
      const gate = await requirePermOrResult(ctx, 'files.view');
      if (!gate.ok) return gate;
      const fileIds = (Array.isArray(args?.fileIds) ? args.fileIds : []).map((id) => String(id ?? '')).filter(Boolean);
      if (fileIds.length === 0) return { ok: false as const, error: 'Не выбрано ни одной фотографии' };
      const dir = await filesDownloadDirGet(ctx.sysDb, { defaultDir: app.getPath('downloads') });
      if (!dir.ok) return dir;
      const staged = await filesStageForShare(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
        fileIds,
        downloadDir: dir.path,
        label: String(args?.label || 'Фото для печати'),
      });
      if (!staged.ok) return { ok: false as const, error: staged.error };
      // Копии объявлены «выданными»: renderer сможет отдать их почте/чату/ИИ,
      // но не сможет подсунуть свой путь (allowlist путей, `pathOriginRegistry`).
      for (const f of staged.files) rememberIssuedPath(f.path);
      const copies = staged.files.map((f) => f.path);
      // Тот же общий шаг печати, что у кнопок над отмеченными картинками.
      const res = await printPhotos(copies, { mode: 'os' });
      // Фокус в окно программы: мастер закрыт — оператор вернулся к нам.
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      if (!res.ok) {
        // Принтера нет — папку с копиями открывать незачем: печатать всё равно нечем.
        if (res.reason === 'no-printers') return { ok: false as const, error: res.error };
        // Мастер не открылся — показываем папку с копиями, оператор вызовет мастер сам.
        await shell.openPath(staged.folder).catch(() => undefined);
        return {
          ok: false as const,
          error: `${res.error}. Открыта папка с копиями фотографий — вызовите мастер печати вручную (Ctrl+P).`,
          folder: staged.folder,
        };
      }
      return { ok: true as const, folder: staged.folder };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}


