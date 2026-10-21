import { BrowserWindow, ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';

import { clearCardDraft, getCardDraft, listCardDrafts, saveCardDraft } from '../../services/cardDraftsService.js';

/**
 * Черновики/recovery-снимки карточек (Phase 3). Owner-private — гейтятся не пермишеном, а
 * сессией (currentUser внутри сервиса); записи запрещены в view-mode (read-only клиент).
 */

/** Сообщаем окнам, что список черновиков изменился: счётчик на вкладке обновляется сразу. */
function emitDraftsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('drafts:changed');
  }
}

export function registerDraftsIpc(ctx: IpcContext) {
  ipcMain.handle('drafts:save', async (_e, args: { cardType: string; cardId: string; kind?: 'recovery' | 'explicit'; title?: string | null; payloadJson?: string | null; baseUpdatedAt?: number | null }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const res = await saveCardDraft(ctx.dataDb(), {
      cardType: String(args?.cardType ?? ''),
      cardId: String(args?.cardId ?? ''),
      ...(args?.kind ? { kind: args.kind } : {}),
      ...(args?.title !== undefined ? { title: args.title } : {}),
      ...(args?.payloadJson !== undefined ? { payloadJson: args.payloadJson } : {}),
      ...(args?.baseUpdatedAt !== undefined ? { baseUpdatedAt: args.baseUpdatedAt } : {}),
    });
    if (res.ok) emitDraftsChanged();
    return res;
  });

  ipcMain.handle('drafts:list', async () => listCardDrafts(ctx.dataDb()));

  ipcMain.handle('drafts:get', async (_e, args: { cardType: string; cardId: string }) =>
    getCardDraft(ctx.dataDb(), { cardType: String(args?.cardType ?? ''), cardId: String(args?.cardId ?? '') }),
  );

  ipcMain.handle('drafts:clear', async (_e, args: { id?: string; cardType?: string; cardId?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const res = await clearCardDraft(ctx.dataDb(), {
      ...(args?.id ? { id: String(args.id) } : {}),
      ...(args?.cardType ? { cardType: String(args.cardType) } : {}),
      ...(args?.cardId ? { cardId: String(args.cardId) } : {}),
    });
    if (res.ok) emitDraftsChanged();
    return res;
  });
}
