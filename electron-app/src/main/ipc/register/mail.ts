import { ipcMain, shell } from 'electron';
import { dirname } from 'node:path';

import { consumeIssuedPath } from '../pathOriginRegistry.js';
import { openMailDraft, prepareMailAttachment, revealMailAttachment, type MailAttachmentSpec } from '../../services/mailService.js';
import type { IpcContext } from '../ipcContext.js';

/**
 * Почта: письмо с формой программы. Своего сервера у завода нет — программе остаётся
 * подготовить файл и открыть клиент оператора, поэтому прав здесь не спрашиваем: серверных
 * данных эти двери не трогают.
 *
 * ── Проверено 26.11.2026 (промт КАРМАНА #144, «действия с принятыми файлами») ──
 *
 * **Программа НЕ умеет отправлять письма с вложениями.** Три причины, по одной на канал:
 *
 * 1. `prepareAttachment` собирает ВЫГРУЗКУ ФОРМЫ (список или карточка) — это файл на диске,
 *    который оператор сам прикрепляет в почтовом клиенте. Произвольные файлы (с Верстака,
 *    из вложений карточки) сюда не попадают: у формы нет «источника», из которого можно
 *    взять байты, и подставлять чужой путь нельзя — это был бы мост «отдай любой файл с диска».
 * 2. `openDraft` открывает системный клиент через `mailto:`. **`mailto:` вложений не умеет**
 *    по определению протокола — это не ограничение Electron, а формат ссылки.
 * 3. Своего SMTP/IMAP нет и заводить его — не наша работа (решение владельца 20.10.2026).
 *
 * Поэтому «отправить файл по почте» в программе означает ровно одно: файлы собираются в
 * папку через файловый слой (`files:revealForShare` — он же держит проверку доступа), папка
 * открывается в Проводнике, а почтовый клиент открывается с темой и текстом. Вложение
 * оператор тащит в письмо руками — и программа ОБЯЗАНА сказать ему это словами, а не
 * молча отправить пустое письмо.
 *
 * Где это говорится оператору: панель действий над выделенными файлами на Верстаке
 * (`components/DesktopFileActionsPanel.tsx` + `DesktopPane.tsx`). Сторож
 * `main/ipc/register/mail.guard.test.ts` держит эту договорённость: если почта когда-нибудь
 * научится прикреплять файлы, сторож потребует поправить и слово оператору.
 */

/** Может ли программа прикрепить файл к письму сама. Ответ проверен и зафиксирован (см. выше). */
export const MAIL_CAN_ATTACH_FILES = false;

/** Что именно оператору сказать, когда действие «отправить по почте» его нажал. */
export const MAIL_ATTACHMENT_LIMITATION =
  'Программа не умеет прикреплять файлы к письму сама: своего почтового сервера нет, а mailto: вложений не умеет. Файлы лежат в открытой папке — перетащите их в письмо.';

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

  /**
   * «Отправить на почту» для файлов, которые лежат на диске оператора
   * (промт КАРМАНА #158 — выдача «Поиска по файлам»).
   *
   * Своего почтового сервера у завода нет, а `mailto:` вложений не умеет, поэтому
   * программа делает ровно то, что уже умеет (см. договорённость выше): открывает
   * папку с файлами и почтовый клиент, а оператор прикрепляет файлы руками. Слова
   * об этом он должен услышать — иначе будет ждать отправки, которой нет.
   *
   * Пути принимаются только те, что выдал главный процесс (`consumeIssuedPath`):
   * renderer не может подсунуть произвольный путь и увести программу читать чужой
   * файл с диска.
   */
  ipcMain.handle(
    'mail:prepareLocalAttachment',
    async (
      _e,
      args: { paths?: string[]; label?: string; subject?: string; body?: string },
    ): Promise<{ ok: true; folder: string; note: string } | { ok: false; error: string }> => {
      const list = (Array.isArray(args?.paths) ? args.paths : [])
        .map((p) => String(p ?? '').trim())
        .filter(Boolean)
        .slice(0, 200);
      if (list.length === 0) return { ok: false, error: 'Нет файлов для письма' };
      for (const p of list) {
        if (!consumeIssuedPath(p)) {
          return { ok: false, error: 'Файл не выдан программой — выберите файлы заново' };
        }
      }
      const folder = dirname(list[0] ?? '');
      if (!folder) return { ok: false, error: 'Не удалось определить папку с файлами' };
      const label = String(args?.label || 'Фото двигателя');
      await shell.openPath(folder).catch(() => undefined);
      const draft = await openMailDraft({
        subject: String(args?.subject || label),
        body:
          String(args?.body || '') +
          `\n\nФайлы лежат в открытой папке:\n${folder}\n\n${MAIL_ATTACHMENT_LIMITATION}`,
      });
      if (!draft.ok) return { ok: false, error: draft.error };
      // Ограничение отдаём и в UI: оператор должен услышать его в программе, а не
      // только прочитать в теле письма — иначе он будет ждать отправки, которой нет.
      return { ok: true, folder, note: MAIL_ATTACHMENT_LIMITATION };
    },
  );
}
