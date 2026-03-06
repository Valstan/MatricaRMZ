import { BrowserWindow, dialog, ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';

import {
  checkForUpdates,
  getUpdateDownloadDir,
  getUpdateState,
  resetUpdateCache,
  setUpdateDownloadDir,
} from '../../services/updateService.js';
import { SettingsKey, settingsGetBoolean } from '../../services/settingsStore.js';

export function registerUpdateIpc(ctx: IpcContext) {
  ipcMain.handle('update:check', async () => {
    const gate = await requirePermOrResult(ctx, 'updates.use');
    if (!gate.ok) return { ok: false as const, error: gate.error };
    const enabled = await settingsGetBoolean(ctx.sysDb, SettingsKey.UpdatesEnabled, true);
    if (!enabled) return { ok: true as const, updateAvailable: false };
    return checkForUpdates();
  });

  ipcMain.handle('update:status', async () => {
    const gate = await requirePermOrResult(ctx, 'updates.use');
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return { ok: true as const, status: getUpdateState() };
  });

  ipcMain.handle('update:reset', async () => {
    const gate = await requirePermOrResult(ctx, 'updates.use');
    if (!gate.ok) return { ok: false as const, error: gate.error };
    await resetUpdateCache('ui');
    return { ok: true as const };
  });

  ipcMain.handle('update:downloadDir:get', async () => {
    const gate = await requirePermOrResult(ctx, 'updates.use');
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return getUpdateDownloadDir();
  });

  ipcMain.handle('update:downloadDir:pick', async () => {
    const gate = await requirePermOrResult(ctx, 'updates.use');
    if (!gate.ok) return { ok: false as const, error: gate.error };
    try {
      const parent = BrowserWindow.getFocusedWindow();
      const opts = {
        title: 'Выберите папку для скачивания обновлений',
        properties: ['openDirectory', 'createDirectory'] as const,
      };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      const path = r.filePaths?.[0] ? String(r.filePaths[0]) : '';
      if (!path) return { ok: false as const, error: 'cancelled' };
      return setUpdateDownloadDir(path);
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}


