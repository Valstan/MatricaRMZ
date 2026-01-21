import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';

import { checkForUpdates, getUpdateState } from '../../services/updateService.js';
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
}


