/**
 * Per-user privacy filtering for sync pull paths (chat / notes).
 *
 * Chat messages, chat reads, notes and note-shares are private: a user may only
 * pull rows they own / participate in (plus broadcast chats and notes shared
 * with them). The incremental path (`pullChangesSince`) enforces this at the SQL
 * level; the cold-snapshot (`/state/snapshot`) and ad-hoc (`/state/query`) paths
 * post-filter the fetched rows with `makePrivacyRowFilter` so all three pull
 * surfaces are consistent. (security-hardening-2026-06 H1-A — snapshot/query gap)
 *
 * `user_presence` is intentionally NOT private — it is a shared online indicator,
 * broadcast on every path including `/state/changes`.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { SyncTableName, canSeeChatRoom } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { chatRooms, notes, noteShares } from '../../database/schema.js';

/** Privacy-sensitive table names that need per-user filtering. */
export const PRIVACY_TABLES = new Set<string>([
  SyncTableName.ChatMessages,
  SyncTableName.ChatReads,
  SyncTableName.ChatRooms,
  SyncTableName.Notes,
  SyncTableName.NoteShares,
  SyncTableName.CardDrafts,
  SyncTableName.AiChatRequests,
]);

export function isPrivacyTable(table: string): boolean {
  return PRIVACY_TABLES.has(table);
}

/** SQL visibility predicate for the incremental PG query (drizzle columns). */
export function privacyFilterForTable(
  tableName: string,
  pgTable: any,
  actorId: string,
  actorIsPending: boolean,
): any | undefined {
  switch (tableName) {
    case SyncTableName.ChatMessages: {
      const conditions: any[] = [eq(pgTable.senderUserId, actorId), eq(pgTable.recipientUserId, actorId)];
      if (!actorIsPending) {
        // Общий чат — это отсутствие ОБОИХ адресов. Без проверки room_id сообщения комнат
        // (у них адресата-человека нет) утекли бы всем как широковещательные.
        conditions.push(and(isNull(pgTable.recipientUserId), isNull(pgTable.roomId)));
        conditions.push(
          inArray(
            pgTable.roomId,
            db
              .select({ id: chatRooms.id })
              .from(chatRooms)
              .where(or(eq(chatRooms.ownerUserId, actorId), sql`${chatRooms.membersJson} LIKE ${'%' + actorId + '%'}`)),
          ),
        );
      }
      return or(...conditions);
    }
    case SyncTableName.ChatRooms: {
      if (actorIsPending) return sql`false`;
      // Не приглашённый не видит комнату ВОВСЕ — ни переписки, ни названия. Список участников
      // лежит JSON-строкой, поэтому грубый LIKE отбирает кандидатов в SQL, а точную
      // принадлежность досчитывает построчный фильтр ниже (общий с snapshot-путём).
      return or(eq(pgTable.ownerUserId, actorId), sql`${pgTable.membersJson} LIKE ${'%' + actorId + '%'}`);
    }
    case SyncTableName.ChatReads:
      return eq(pgTable.userId, actorId);
    case SyncTableName.Notes:
      return eq(pgTable.ownerUserId, actorId);
    case SyncTableName.NoteShares:
      return eq(pgTable.recipientUserId, actorId);
    case SyncTableName.CardDrafts:
      return eq(pgTable.ownerUserId, actorId);
    case SyncTableName.AiChatRequests:
      return eq(pgTable.userId, actorId);
    default:
      return undefined;
  }
}

/** Note IDs shared WITH the actor (so notes shared with them are included). */
export async function getSharedNoteIds(actorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ noteId: noteShares.noteId })
    .from(noteShares)
    .where(and(eq(noteShares.recipientUserId, actorId), isNull(noteShares.deletedAt), eq(noteShares.hidden, false)))
    .limit(50_000);
  return new Set(rows.map((r) => String(r.noteId)));
}

/**
 * Ограничение для админа, который НЕ суперадминистратор: всё, кроме чужих комнат. Отдельная
 * функция, потому что на SQL-пути админ обычно фильтр не получает вовсе.
 */
export function adminRoomFilterForTable(tableName: string, pgTable: any, actorId: string): any | undefined {
  if (tableName === SyncTableName.ChatRooms) {
    return or(eq(pgTable.ownerUserId, actorId), sql`${pgTable.membersJson} LIKE ${'%' + actorId + '%'}`);
  }
  if (tableName === SyncTableName.ChatMessages) {
    return or(
      isNull(pgTable.roomId),
      inArray(
        pgTable.roomId,
        db
          .select({ id: chatRooms.id })
          .from(chatRooms)
          .where(or(eq(chatRooms.ownerUserId, actorId), sql`${chatRooms.membersJson} LIKE ${'%' + actorId + '%'}`)),
      ),
    );
  }
  return undefined;
}

/**
 * Комнаты, видимые этому пользователю. Точную принадлежность считает общий доменный
 * предикат: SQL-фильтр отбирает по подстроке, а «участник ли он на самом деле» решается
 * здесь — иначе идентификатор, случайно оказавшийся подстрокой чужого, открыл бы комнату.
 */
export async function getVisibleChatRoomIds(actorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: chatRooms.id, ownerUserId: chatRooms.ownerUserId, membersJson: chatRooms.membersJson })
    .from(chatRooms)
    .where(isNull(chatRooms.deletedAt))
    .limit(50_000);
  const out = new Set<string>();
  for (const r of rows) {
    if (canSeeChatRoom({ ownerUserId: String(r.ownerUserId ?? ''), membersJson: r.membersJson }, actorId)) {
      out.add(String(r.id));
    }
  }
  return out;
}

/** Note IDs OWNED by the actor (so shares of their own notes are included). */
export async function getOwnedNoteIds(actorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.ownerUserId, actorId), isNull(notes.deletedAt)))
    .limit(50_000);
  return new Set(rows.map((r) => String(r.id)));
}

type PrivacyActor = { id: string; isAdmin: boolean; isPending: boolean; isSuperadmin?: boolean };
type PrivacyCtx = { sharedNoteIds: Set<string>; ownedNoteIds: Set<string>; visibleRoomIds: Set<string> };

/**
 * Row-level visibility predicate over the sync-row (snake_case) shape, for the
 * snapshot / query paths that fetch rows then post-filter. Mirrors the SQL
 * predicate above. Admins see everything; pending users see no private rows.
 */
export function makePrivacyRowFilter(
  actor: PrivacyActor,
  ctx: PrivacyCtx,
): (table: string, row: Record<string, unknown>) => boolean {
  return (table, row) => {
    if (!isPrivacyTable(table)) return true;
    if (actor.isAdmin) {
      // Комнаты — единственное исключение из админского обзора: владелец 08.09.2026 назвал
      // допущенными только участников и суперадминистратора. Прочая переписка админам
      // видна по-прежнему (это давнее правило, комнаты его не меняют).
      if (actor.isSuperadmin === true) return true;
      if (table === SyncTableName.ChatRooms) return ctx.visibleRoomIds.has(String(row['id'] ?? ''));
      if (table === SyncTableName.ChatMessages) {
        const roomId = String(row['room_id'] ?? '');
        if (roomId) return ctx.visibleRoomIds.has(roomId);
      }
      return true;
    }
    if (actor.isPending) return false;
    switch (table) {
      case SyncTableName.ChatMessages: {
        const sender = String(row['sender_user_id'] ?? '');
        const recipient = row['recipient_user_id'];
        const roomId = String(row['room_id'] ?? '');
        if (roomId) return ctx.visibleRoomIds.has(roomId);
        if (sender === actor.id) return true;
        if (String(recipient ?? '') === actor.id) return true;
        return recipient === null || recipient === undefined; // broadcast (общий чат)
      }
      case SyncTableName.ChatRooms:
        return ctx.visibleRoomIds.has(String(row['id'] ?? ''));
      case SyncTableName.ChatReads:
        return String(row['user_id'] ?? '') === actor.id;
      case SyncTableName.Notes:
        return String(row['owner_user_id'] ?? '') === actor.id || ctx.sharedNoteIds.has(String(row['id'] ?? ''));
      case SyncTableName.NoteShares:
        return String(row['recipient_user_id'] ?? '') === actor.id || ctx.ownedNoteIds.has(String(row['note_id'] ?? ''));
      case SyncTableName.CardDrafts:
        return String(row['owner_user_id'] ?? '') === actor.id;
      case SyncTableName.AiChatRequests:
        return String(row['user_id'] ?? '') === actor.id;
      default:
        return true;
    }
  };
}
