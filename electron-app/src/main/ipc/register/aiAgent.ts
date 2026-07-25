import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { aiAgentLogEvent } from '../../services/aiAgentService.js';

// Синхронный AI-контур (ai:assist / ai:assist:stream / ai:conversations:*) снесён
// 2026-07-25: renderer использовал только logEvent, чат ходит асинхронной очередью
// aiChat (v2026.719.1555).
export function registerAiAgentIpc(ctx: IpcContext) {
  ipcMain.removeHandler('ai:log');
  ipcMain.handle('ai:log', async (_e, args) => {
    return await aiAgentLogEvent(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });
}
