import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';

import { currentUser } from '../../services/chatService.js';
import { desktopInboxList, desktopSendFile } from '../../services/desktopTransferService.js';

/**
 * Передача файлов между Верстаками. Транспорт — личное сообщение чата с файлом: оно уже
 * доезжает получателю и уже выдаёт ему доступ к файлу. Отсюда и право: `chat.use` — то же,
 * что и на отправку файла в чат, потому что это буквально она и есть.
 */
export function registerDesktopTransferIpc(ctx: IpcContext) {
  ipcMain.handle('desktopTransfer:send', async (_e, args: { fileId: string; recipientUserId: string }) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'передача файлов недоступна в режиме бэкапа' };
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'chat.use');
    if (!gate.ok) return gate;
    const me = await currentUser(ctx.sysDb);
    if (!me) return { ok: false as const, error: 'auth required' };
    return desktopSendFile(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
      fileId: String(args?.fileId ?? ''),
      recipientUserId: String(args?.recipientUserId ?? ''),
      senderUserId: me.id,
      senderUsername: me.username,
    });
  });

  // Чтение: список входящих строится по локальной реплике чата, без сети.
  ipcMain.handle('desktopTransfer:inbox', async () => {
    const me = await currentUser(ctx.sysDb);
    if (!me) return { ok: false as const, error: 'auth required' };
    return desktopInboxList(ctx.dataDb(), { userId: me.id });
  });
}
