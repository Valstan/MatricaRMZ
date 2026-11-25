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
  chatRoomDelete,
  chatRoomSave,
  chatRoomsList,
  chatSendDeepLink,
  chatSendTextEverywhere,
  chatSendFile,
  chatSendText,
  chatUnreadCount,
  chatUsersList,
} from '../../services/chatService.js';
import { notifyExchangeBot } from '../../services/exchangeBotService.js';

export function registerChatIpc(ctx: IpcContext) {
  // Право `chat.use` до сих пор проверялось только на REST (/chat/users) и в UI —
  // сам IPC пускал любого авторизованного. Гейтим запись здесь, как в aiChat.
  const requireChatUse = () => requirePermOrResult(ctx, 'chat.use');

  /**
   * Бот обмена и пересылки: после отправки сообщения зовём бота — он сам решит,
   * его это сообщение или нет (если нет — промолчит, и это нормально).
   *
   * Звонок не ждём: письмо оператора уже ушло, бот — улучшение, а не условие
   * переписки. Ошибка звонка молча не теряется: бот ответит, когда сможет.
   */
  const callExchangeBot = (args: {
    messageId: string;
    recipientUserId?: string | null | undefined;
    text?: string | null | undefined;
    fileId?: string | null | undefined;
    fileName?: string | null | undefined;
  }) => {
    const recipientUserId = String(args.recipientUserId ?? '').trim();
    if (!recipientUserId) return;
    void notifyExchangeBot(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
      messageId: args.messageId,
      recipientUserId,
      text: args.text ?? null,
      fileId: args.fileId ?? null,
      fileName: args.fileName ?? null,
    });
  };

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
    const r = await chatSendText(ctx.sysDb, args);
    if (r.ok) callExchangeBot({ messageId: r.id, recipientUserId: args?.recipientUserId, text: args?.text });
    return r;
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
    const r = await chatSendFile(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    if (r.ok) {
      callExchangeBot({
        messageId: r.id,
        recipientUserId: args?.recipientUserId,
        fileId: r.fileId ?? null,
      });
    }
    return r;
  });

  ipcMain.handle('chat:sendDeepLink', async (_e, args: { recipientUserId?: string | null; link: any; text?: string | null }) => {
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

  // Гейт возвращает УСПЕХ при наличии права (`{ ok: true }`), а не `undefined`: читать его
  // как «отказ» нельзя — обработчик тогда всегда отвечает `ok` и до сервиса не доходит.
  ipcMain.handle('chat:roomsList', async () => {
    const gate = await requireChatUse();
    if (!gate.ok) return gate;
    return await chatRoomsList(ctx.dataDb());
  });

  ipcMain.handle('chat:roomSave', async (_e, args) => {
    const gate = await requireChatUse();
    if (!gate.ok) return gate;
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    return await chatRoomSave(ctx.sysDb, args ?? {});
  });

  ipcMain.handle('chat:roomDelete', async (_e, args) => {
    const gate = await requireChatUse();
    if (!gate.ok) return gate;
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'chat disabled in backup mode' };
    return await chatRoomDelete(ctx.sysDb, args ?? {});
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

