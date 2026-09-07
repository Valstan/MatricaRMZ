import { randomUUID } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { DesktopInboxItem, DesktopSendFileResult } from '@matricarmz/shared';

import { chatMessages } from '../database/schema.js';

import { filesMeta } from './fileService.js';

/**
 * Передача файлов между Верстаками коллег.
 *
 * Транспорт — **личное сообщение чата с файлом**, а не новая таблица и не новое право. Причина
 * не в экономии: такое сообщение УЖЕ синхронизируется получателю и УЖЕ выдаёт ему доступ к файлу
 * (`chatPayloadGrantsFileAccess` на сервере). Своя таблица потребовала бы правки контракта
 * синхронизации и отдельного источника прав — то есть ровно тех двух мест, где ошибка стоит
 * дороже всего, ради поведения, которое уже есть.
 *
 * Ярлык на Верстаке доступа к файлу не даёт (это записано в модели Верстака), поэтому «отправить»
 * не может быть простым добавлением ярлыка чужому: получателю нужен именно доступ, и его выдаёт
 * сообщение. Согласие получателя («принять N файлов от X») — местное действие в его же профиле.
 */
const INBOX_LIMIT = 200;

/** Отправить коллеге файл, который уже лежит в программе (ярлык Верстака, вложение карточки). */
export async function desktopSendFile(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { fileId: string; recipientUserId: string; senderUserId: string; senderUsername: string },
): Promise<DesktopSendFileResult> {
  const fileId = String(args.fileId ?? '').trim();
  const recipientUserId = String(args.recipientUserId ?? '').trim();
  if (!fileId) return { ok: false, error: 'файл не указан' };
  if (!recipientUserId) return { ok: false, error: 'получатель не указан' };
  if (recipientUserId === args.senderUserId) return { ok: false, error: 'это вы сами' };

  // Мета берётся у сервера — заодно это проверка ДОСТУПА отправителя: переслать можно только то,
  // к чему есть доступ у самого. Без неё «отправить» стало бы способом раздать чужой файл.
  const meta = await filesMeta(db, apiBaseUrl, { fileId });
  if (!meta.ok) return { ok: false, error: meta.error };

  const ts = Date.now();
  const id = randomUUID();
  await db.insert(chatMessages).values({
    id,
    senderUserId: args.senderUserId,
    senderUsername: args.senderUsername,
    recipientUserId,
    messageType: 'file',
    bodyText: meta.file.name,
    payloadJson: JSON.stringify(meta.file),
    createdAt: ts,
    updatedAt: ts,
    syncStatus: 'pending',
    deletedAt: null,
  } as never);

  return { ok: true, messageId: id, fileName: meta.file.name };
}

/**
 * Входящие файлы: личные сообщения с файлом, адресованные мне. Разбирает их Верстак получателя —
 * список «разобранных» живёт в его профиле, поэтому здесь отдаём всё, а фильтрует потребитель
 * (`desktopPendingInbox`): что уже принято на одной машине, не предложится на второй.
 */
export async function desktopInboxList(
  db: BetterSQLite3Database,
  args: { userId: string },
): Promise<{ ok: true; items: DesktopInboxItem[] } | { ok: false; error: string }> {
  const userId = String(args.userId ?? '').trim();
  if (!userId) return { ok: false, error: 'auth required' };
  try {
    const rows = await db
      .select()
      .from(chatMessages)
      .where(
        and(
          isNull(chatMessages.deletedAt),
          eq(chatMessages.recipientUserId, userId),
          eq(chatMessages.messageType, 'file'),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(INBOX_LIMIT);

    const items: DesktopInboxItem[] = [];
    for (const raw of rows as Array<Record<string, unknown>>) {
      let file: { id?: unknown; name?: unknown; mime?: unknown } | null = null;
      try {
        file = JSON.parse(String(raw.payloadJson ?? 'null'));
      } catch {
        file = null;
      }
      const fileId = String(file?.id ?? '').trim();
      if (!fileId) continue;
      items.push({
        messageId: String(raw.id ?? ''),
        senderUserId: String(raw.senderUserId ?? ''),
        senderUsername: String(raw.senderUsername ?? ''),
        fileId,
        fileName: String(file?.name ?? raw.bodyText ?? 'файл'),
        mime: file?.mime == null ? null : String(file.mime),
        sentAt: Number(raw.createdAt ?? 0),
      });
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
