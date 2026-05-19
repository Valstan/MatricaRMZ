import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import {
  aiAgentAssist,
  aiAgentAssistStream,
  aiAgentConversationDelete,
  aiAgentConversationMessages,
  aiAgentConversationSearch,
  aiAgentConversationsList,
  aiAgentLogEvent,
} from '../../services/aiAgentService.js';

export function registerAiAgentIpc(ctx: IpcContext) {
  ipcMain.removeHandler('ai:assist');
  ipcMain.removeHandler('ai:log');
  ipcMain.removeHandler('ai:ollama-health');
  ipcMain.removeHandler('ai:conversations:list');
  ipcMain.removeHandler('ai:conversations:get');
  ipcMain.removeHandler('ai:conversations:delete');
  ipcMain.removeHandler('ai:conversations:search');
  ipcMain.removeHandler('ai:assist:stream');

  ipcMain.handle('ai:assist', async (_e, args) => {
    return await aiAgentAssist(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });
  ipcMain.handle('ai:log', async (_e, args) => {
    return await aiAgentLogEvent(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });
  ipcMain.handle('ai:conversations:list', async (_e, args) => {
    return await aiAgentConversationsList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args ?? {});
  });
  ipcMain.handle('ai:conversations:get', async (_e, args) => {
    return await aiAgentConversationMessages(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });
  ipcMain.handle('ai:conversations:delete', async (_e, args) => {
    return await aiAgentConversationDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });
  ipcMain.handle('ai:conversations:search', async (_e, args) => {
    return await aiAgentConversationSearch(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });
  ipcMain.handle('ai:assist:stream', async (event, payload) => {
    const channel = String(payload?.channelId ?? '');
    if (!channel) return { ok: false, error: 'missing channelId' };
    return await aiAgentAssistStream(
      ctx.sysDb,
      ctx.mgr.getApiBaseUrl(),
      payload?.args ?? {},
      (ev) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(channel, ev);
        }
      },
    );
  });
}
