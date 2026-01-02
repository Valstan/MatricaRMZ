import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';

import { logMessage, logMessageGetEnabled, logMessageSetEnabled } from '../../services/logService.js';

export function registerLoggingIpc(ctx: IpcContext) {
  ipcMain.handle('log:send', async (_e, payload: { level: 'debug' | 'info' | 'warn' | 'error'; message: string }) => {
    ctx.logToFile(`renderer ${payload.level}: ${payload.message}`);
    // If enabled — buffer and send to server
    await logMessage(ctx.sysDb, ctx.mgr.getApiBaseUrl(), payload.level, payload.message, { source: 'renderer' }).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('logging:getEnabled', async () => {
    return { ok: true, enabled: await logMessageGetEnabled(ctx.sysDb) };
  });

  ipcMain.handle('logging:setEnabled', async (_e, enabled: boolean) => {
    // Allow only for users who can sync (so we don't spam the server from unauthorized clients)
    const gate = await requirePermOrResult(ctx, 'sync.use');
    if (!gate.ok) return gate;

    await logMessageSetEnabled(ctx.sysDb, enabled, ctx.mgr.getApiBaseUrl());
    return { ok: true };
  });
}


