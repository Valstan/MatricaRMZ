/**
 * Запись сообщения в чат программы — одна точка на всех, кто пишет.
 *
 * Зачем сервис, если в `routes/chat.ts` сообщение и так пишется: аларм «сообщить
 * администратору» тоже должен оставить сообщение В ЧАТЕ, и второй копии формата
 * строки быть не должно — иначе клиент и сервер разойдутся в полях (клиент тащит
 * DTO по реестру, и лишнее поле в payload строки «съедает» синх молча).
 *
 * Пишем через журнал синка (`recordSyncChanges`): строка без номера журнала не
 * видна инкрементальному pull'у — сообщение дошло бы до сервера, но не до парка.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { SyncTableName } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { chatMessages, chatRooms } from '../database/schema.js';
import { getSuperadminUserId } from './employeeAuthService.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

export type ChatMessageRow = {
  id: string;
  senderUserId: string;
  senderUsername: string;
  recipientUserId: string | null;
  messageType: string;
  bodyText: string | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
};

/** Строка чата в виде DTO синк-контракта (snake_case) — так её ждёт реестр. */
export function chatMessagePayload(row: ChatMessageRow) {
  return {
    id: String(row.id),
    sender_user_id: String(row.senderUserId),
    sender_username: String(row.senderUsername),
    recipient_user_id: row.recipientUserId == null ? null : String(row.recipientUserId),
    message_type: String(row.messageType),
    body_text: row.bodyText == null ? null : String(row.bodyText),
    payload_json: row.payloadJson == null ? null : String(row.payloadJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

export type PostChatMessageInput = {
  /** Кто пишет (id и логин). */
  senderUserId: string;
  senderUsername: string;
  /** Кому пишут; `null` — в общий чат. */
  recipientUserId?: string | null;
  text: string;
  /** Тип сообщения; по умолчанию обычный текст. */
  messageType?: string;
  /** Кто инициировал запись (для журнала синка). */
  actor?: { id: string; username: string; role?: string | null };
};

/**
 * Записать сообщение в чат и отдать его парку.
 *
 * Возвращает `{ ok: false }`, если текста нет — молча уходить нельзя: вызывающий
 * (аларм) должен сказать оператору, что сообщение не дошло.
 */
export async function postChatMessage(input: PostChatMessageInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const text = String(input.text ?? '').trim();
  if (!text) return { ok: false, error: 'пустое сообщение' };
  const senderUserId = String(input.senderUserId ?? '').trim();
  if (!senderUserId) return { ok: false, error: 'нет отправителя' };

  const ts = Date.now();
  const id = randomUUID();
  const recipientUserId = input.recipientUserId ? String(input.recipientUserId) : null;
  const messageType = String(input.messageType ?? 'text');

  await db.insert(chatMessages).values({
    id,
    senderUserId: senderUserId as any,
    senderUsername: String(input.senderUsername ?? ''),
    recipientUserId: recipientUserId ? (recipientUserId as any) : null,
    messageType,
    bodyText: text,
    payloadJson: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });

  const payload = chatMessagePayload({
    id,
    senderUserId,
    senderUsername: String(input.senderUsername ?? ''),
    recipientUserId,
    messageType,
    bodyText: text,
    payloadJson: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await recordSyncChanges(
    {
      id: input.actor?.id ?? senderUserId,
      username: input.actor?.username ?? String(input.senderUsername ?? ''),
      role: input.actor?.role ?? 'user',
    },
    [
      {
        tableName: SyncTableName.ChatMessages,
        rowId: id,
        op: 'upsert',
        payload,
        ts,
      },
    ],
  );
  return { ok: true, id };
}

/**
 * Написать супер-админу (владельцу) от имени оператора.
 *
 * Сообщение выглядит как обычное: оператор → администратор. Это и есть «сообщить
 * администратору» — администратор видит его в своём чате, как любое другое письмо.
 */
export async function postChatMessageToSuperadmin(args: {
  senderUserId: string;
  senderUsername: string;
  text: string;
  actor?: { id: string; username: string; role?: string | null };
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const superadminId = await getSuperadminUserId();
  if (!superadminId) return { ok: false, error: 'в системе нет супер-администратора' };
  // Писать самому себе смысла нет: сообщение «от меня мне» — шум в чате.
  if (superadminId === String(args.senderUserId)) return { ok: false, error: 'отчёт отправлен супер-администратору (это он сам)' };
  return postChatMessage({
    senderUserId: args.senderUserId,
    senderUsername: args.senderUsername,
    recipientUserId: superadminId,
    text: args.text,
    ...(args.actor ? { actor: args.actor } : {}),
  });
}

/**
 * Комната тревог: «Мониторинг завода». Сервер заводит её один раз и пишет в неё все
 * алармы — так тревога не теряется в личке (личные сообщения прокручиваются и молчат),
 * а в комнату можно позвать заместителя администратора.
 *
 * Внешний канал (МАКС) без бота невозможен: писать в чат может только бот или
 * пользователь от своего имени. Комната в программе — тот же эффект без внешних
 * препонов: свой чат, свой бейдж, свой журнал.
 */
export const MONITORING_ROOM_TITLE = 'Мониторинг завода';
/** Фиксированный id комнаты: комната одна на завод, и её не надо искать по названию. */
export const MONITORING_ROOM_ID = '9a3f1c60-2b7e-4d55-8c10-6f2d84be5173';

/**
 * Завести комнату тревог (если её ещё нет) и вернуть её id.
 *
 * Создатель — супер-админ: он видит любую комнату и по умолчанию состоит в своей.
 * Публикуем через журнал синка: строка без номера журнала не видна клиентам, и комната
 * была бы «создана», но не появилась бы ни у кого.
 */
export async function ensureMonitoringRoom(): Promise<string | null> {
  const existing = await db
    .select({ id: chatRooms.id })
    .from(chatRooms)
    .where(and(eq(chatRooms.id, MONITORING_ROOM_ID), isNull(chatRooms.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return String(existing[0].id);

  const superadminId = await getSuperadminUserId();
  if (!superadminId) return null;

  const ts = Date.now();
  await db
    .insert(chatRooms)
    .values({
      id: MONITORING_ROOM_ID as any,
      ownerUserId: superadminId as any,
      title: MONITORING_ROOM_TITLE,
      membersJson: null,
      createdAt: ts,
      updatedAt: ts,
      lastServerSeq: null,
      deletedAt: null,
      syncStatus: 'synced',
    })
    .onConflictDoNothing();
  await recordSyncChanges(
    { id: superadminId, username: 'system', role: 'superadmin' },
    [
      {
        tableName: SyncTableName.ChatRooms,
        rowId: MONITORING_ROOM_ID,
        op: 'upsert',
        payload: {
          id: MONITORING_ROOM_ID,
          owner_user_id: superadminId,
          title: MONITORING_ROOM_TITLE,
          members_json: null,
          created_at: ts,
          updated_at: ts,
          deleted_at: null,
          last_server_seq: null,
          sync_status: 'synced',
        },
        ts,
      },
    ],
  );
  return MONITORING_ROOM_ID;
}

/** Написать в комнату чата (сообщение адресовано комнате, а не человеку). */
export async function postChatMessageToRoom(args: {
  roomId: string;
  senderUserId: string;
  senderUsername: string;
  text: string;
  actor?: { id: string; username: string; role?: string | null };
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const text = String(args.text ?? '').trim();
  if (!text) return { ok: false, error: 'пустое сообщение' };
  const senderUserId = String(args.senderUserId ?? '').trim();
  if (!senderUserId) return { ok: false, error: 'нет отправителя' };
  const roomId = String(args.roomId ?? '').trim();
  if (!roomId) return { ok: false, error: 'нет комнаты' };

  const ts = Date.now();
  const id = randomUUID();
  await db.insert(chatMessages).values({
    id,
    senderUserId: senderUserId as any,
    senderUsername: String(args.senderUsername ?? ''),
    recipientUserId: null,
    roomId: roomId as any,
    messageType: 'text',
    bodyText: text,
    payloadJson: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await recordSyncChanges(
    {
      id: args.actor?.id ?? senderUserId,
      username: args.actor?.username ?? String(args.senderUsername ?? ''),
      role: args.actor?.role ?? 'user',
    },
    [
      {
        tableName: SyncTableName.ChatMessages,
        rowId: id,
        op: 'upsert',
        payload: {
          id,
          sender_user_id: senderUserId,
          sender_username: String(args.senderUsername ?? ''),
          recipient_user_id: null,
          room_id: roomId,
          message_type: 'text',
          body_text: text,
          payload_json: null,
          created_at: ts,
          updated_at: ts,
          deleted_at: null,
          sync_status: 'synced',
        },
        ts,
      },
    ],
  );
  return { ok: true, id };
}
