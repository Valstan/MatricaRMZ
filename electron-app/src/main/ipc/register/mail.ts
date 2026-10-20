import { ipcMain } from 'electron';

import { openMailDraft, prepareMailAttachment, revealMailAttachment, type MailAttachmentSpec } from '../../services/mailService.js';
import type { IpcContext } from '../ipcContext.js';

/**
 * Почта: письмо с формой программы. Своего сервера у завода нет — программе остаётся
 * подготовить файл и открыть клиент оператора, поэтому прав здесь не спрашиваем: серверных
 * данных эти двери не трогают.
 */
export function registerMailIpc(_ctx: IpcContext) {
  ipcMain.handle('mail:prepareAttachment', async (_e, args: MailAttachmentSpec) => {
    if (!args || (args.kind !== 'list' && args.kind !== 'card')) {
      return { ok: false, error: 'вложение не указано' };
    }
    return prepareMailAttachment(args);
  });

  ipcMain.handle('mail:revealAttachment', async (_e, args: { path: string }) => revealMailAttachment(args?.path));

  ipcMain.handle('mail:openDraft', async (_e, args: { to?: string; cc?: string; subject: string; body: string }) =>
    openMailDraft(args ?? { subject: '', body: '' }),
  );
}
