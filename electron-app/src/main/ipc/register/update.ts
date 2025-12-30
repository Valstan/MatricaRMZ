import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';

import { checkForUpdates } from '../../services/updateService.js';

export function registerUpdateIpc(ctx: IpcContext) {
  ipcMain.handle('update:check', async () => {
    const gate = await requirePermOrResult(ctx, 'updates.use');
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return checkForUpdates();
  });
}


