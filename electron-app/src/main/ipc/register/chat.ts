import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { chatAdminListPair, chatExport, chatList, chatMarkRead, chatSendDeepLink, chatSendFile, chatSendText, chatUnreadCount, chatUsersList } from '../../services/chatService.js';

export function registerChatIpc(ctx: IpcContext) {
  ipcMain.handle('chat:usersList', async () => {
    return await chatUsersList(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('chat:list', async (_e, args: { mode: 'global' | 'private'; withUserId?: string | null; limit?: number }) => {
    return await chatList(ctx.dataDb(), args);
  });

  ipcMain.handle('chat:adminListPair', async (_e, args: { userAId: string; userBId: string; limit?: number }) => {
    return await chatAdminListPair(ctx.dataDb(), args);
  });

  ipcMain.handle('chat:sendText', async (_e, args: { recipientUserId?: string | null; text: string }) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    return await chatSendText(ctx.sysDb, args);
  });

  ipcMain.handle('chat:sendFile', async (_e, args: { recipientUserId?: string | null; path: string }) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    return await chatSendFile(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('chat:sendDeepLink', async (_e, args: { recipientUserId?: string | null; link: any }) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    return await chatSendDeepLink(ctx.sysDb, args);
  });

  ipcMain.handle('chat:markRead', async (_e, args: { messageIds: string[] }) => {
    return await chatMarkRead(ctx.sysDb, args);
  });

  ipcMain.handle('chat:unreadCount', async () => {
    return await chatUnreadCount(ctx.sysDb);
  });

  ipcMain.handle('chat:export', async (_e, args: { startMs: number; endMs: number }) => {
    return await chatExport(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });
}

