import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { aiAgentAssist, aiAgentLogEvent } from '../../services/aiAgentService.js';

export function registerAiAgentIpc(ctx: IpcContext) {
  ipcMain.removeHandler('ai:assist');
  ipcMain.removeHandler('ai:log');
  ipcMain.handle('ai:assist', async (_e, args) => {
    return await aiAgentAssist(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('ai:log', async (_e, args) => {
    return await aiAgentLogEvent(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });
}
