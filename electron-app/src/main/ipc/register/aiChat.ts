import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult } from '../ipcContext.js';
import { consumeIssuedPath } from '../pathOriginRegistry.js';
import {
  aiChatCreate,
  aiChatDelete,
  aiChatList,
  aiChatMeta,
  aiChatSetVerdict,
  aiChatUpdate,
} from '../../services/aiChatService.js';

const writeError = { ok: false as const, error: 'AI-чат недоступен в режиме просмотра бэкапа' };

export function registerAiChatIpc(ctx: IpcContext) {
  ipcMain.handle('aiChat:list', async () => {
    return await aiChatList(ctx.dataDb());
  });

  ipcMain.handle('aiChat:create', async (_e, args: { questionText: string; filePath?: string }) => {
    if (isViewMode(ctx)) return writeError;
    const gate = await requirePermOrResult(ctx, 'chat.use');
    if (!gate.ok) return gate;
    if (args?.filePath && !consumeIssuedPath(args.filePath)) {
      return { ok: false as const, error: 'путь не из диалога выбора файлов' };
    }
    return await aiChatCreate(ctx.dataDb(), ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('aiChat:update', async (_e, args: { id: string; questionText: string }) => {
    if (isViewMode(ctx)) return writeError;
    return await aiChatUpdate(ctx.dataDb(), args);
  });

  ipcMain.handle('aiChat:delete', async (_e, args: { id: string }) => {
    if (isViewMode(ctx)) return writeError;
    return await aiChatDelete(ctx.dataDb(), args);
  });

  ipcMain.handle('aiChat:setVerdict', async (_e, args: { id: string; verdictText: string }) => {
    if (isViewMode(ctx)) return writeError;
    return await aiChatSetVerdict(ctx.dataDb(), args);
  });

  ipcMain.handle('aiChat:meta', async () => {
    return await aiChatMeta(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });
}
