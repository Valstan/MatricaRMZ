import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';
import { consumeIssuedPath } from '../pathOriginRegistry.js';
import {
  chatAdminListPair,
  chatDeleteMessage,
  chatExport,
  chatList,
  chatMarkRead,
  chatSendDeepLink,
  chatSendTextEverywhere,
  chatSendFile,
  chatSendText,
  chatUnreadCount,
  chatUsersList,
} from '../../services/chatService.js';

export function registerChatIpc(ctx: IpcContext) {
  // Право `chat.use` до сих пор проверялось только на REST (/chat/users) и в UI —
  // сам IPC пускал любого авторизованного. Гейтим запись здесь, как в aiChat.
  const requireChatUse = () => requirePermOrResult(ctx, 'chat.use');

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
    const gate = await requireChatUse();
    if (!gate.ok) return gate;
    return await chatSendText(ctx.sysDb, args);
  });

  ipcMain.handle('chat:sendTextEverywhere', async (_e, args: { recipientUserId?: string | null; text: string }) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    const gate = await requireChatUse();
    if (!gate.ok) return gate;
    return await chatSendTextEverywhere(ctx.sysDb, args);
  });

  ipcMain.handle('chat:sendFile', async (_e, args: { recipientUserId?: string | null; path: string }) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    const gate = await requireChatUse();
    if (!gate.ok) return gate;
    if (!consumeIssuedPath(args?.path)) return { ok: false as const, error: 'путь не из диалога выбора файлов' };
    return await chatSendFile(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('chat:sendDeepLink', async (_e, args: { recipientUserId?: string | null; link: any }) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    const gate = await requireChatUse();
    if (!gate.ok) return gate;
    return await chatSendDeepLink(ctx.sysDb, args);
  });

  ipcMain.handle('chat:markRead', async (_e, args: { messageIds: string[] }) => {
    // В режиме бэкапа список сообщений читается из снимка (dataDb), а пометка
    // прочтения писалась бы в ЖИВУЮ базу — оператор «прочитывал» бы чужие
    // непрочитанные, просто листая архив. Поэтому только live.
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    return await chatMarkRead(ctx.sysDb, args);
  });

  ipcMain.handle('chat:unreadCount', async () => {
    return await chatUnreadCount(ctx.sysDb);
  });

  ipcMain.handle('chat:export', async (_e, args: { startMs: number; endMs: number }) => {
    return await chatExport(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('chat:deleteMessage', async (_e, args: { messageId: string }) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    const gate = await requireChatUse();
    if (!gate.ok) return gate;
    return await chatDeleteMessage(ctx.dataDb(), args);
  });
}

