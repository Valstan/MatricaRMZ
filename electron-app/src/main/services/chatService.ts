import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { basename } from 'node:path';
import { net, dialog, app, BrowserWindow } from 'electron';

import { canEditChatRoom, canSeeChatRoom, parseRoomMembers, serializeRoomMembers } from '@matricarmz/shared';

import type {
  ChatDeepLinkPayload,
  ChatDeleteResult,
  ChatExportResult,
  ChatListResult,
  ChatMessageItem,
  ChatSendResult,
  ChatRoomSaveResult,
  ChatRoomsListResult,
  ChatUnreadCountResult,
  ChatUsersListResult,
} from '@matricarmz/shared';

import { chatMessages, chatReads, chatRooms } from '../database/schema.js';
import { getSession } from './authService.js';
import { httpAuthed } from './httpClient.js';

function nowMs() {
  return Date.now();
}

function safeFilename(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() || 'file';
  return base.replaceAll(/[^a-zA-Z0-9а-яА-Я._ -]+/g, '_').slice(0, 180) || 'file';
}

/** Текущий вошедший: нужен и чату, и передаче файлов между Верстаками. */
export async function currentUser(db: BetterSQLite3Database): Promise<{ id: string; username: string; role: string } | null> {
  const s = await getSession(db).catch(() => null);
  const u = s?.user;
  if (!u?.id) return null;
  return { id: String(u.id), username: String(u.username ?? '').trim() || 'unknown', role: String(u.role ?? '') };
}

async function canAdminViewAllChats(db: BetterSQLite3Database): Promise<boolean> {
  const s = await getSession(db).catch(() => null);
  const role = String(s?.user?.role ?? '').toLowerCase();
  const perm = (s?.permissions ?? {}) as Record<string, boolean>;
  return role === 'admin' && perm['chat.admin.view'] === true;
}

export async function chatUsersList(db: BetterSQLite3Database, apiBaseUrl: string): Promise<ChatUsersListResult> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, '/chat/users', { method: 'GET' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok || !Array.isArray(j.users)) return { ok: false, error: 'bad response' };
    return { ok: true, users: j.users };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function chatList(
  db: BetterSQLite3Database,
  args: { mode: 'global' | 'private' | 'room'; withUserId?: string | null; roomId?: string | null; limit?: number },
): Promise<ChatListResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    const limit = Math.max(1, Math.min(500, args.limit ?? 200));
    const withUserId = args.withUserId ? String(args.withUserId) : null;

    let rows: any[] = [];
    if (args.mode === 'room') {
      const roomId = args.roomId ? String(args.roomId) : '';
      if (!roomId) return { ok: false, error: 'roomId required for room mode' };
      // Комната, которой у нас нет, — это комната, в которую нас не звали: сервер её строку
      // не отдаёт. Отвечаем «нет доступа», а не пустой перепиской, иначе оператор решит,
      // что в комнате просто ничего не писали.
      const room = await loadVisibleRoom(db, me, roomId);
      if (!room) return { ok: false, error: 'room not found' };
      rows = await db
        .select()
        .from(chatMessages)
        .where(and(isNull(chatMessages.deletedAt), eq(chatMessages.roomId, roomId)))
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
    } else if (args.mode === 'global') {
      rows = await db
        .select()
        .from(chatMessages)
        .where(and(isNull(chatMessages.deletedAt), isNull(chatMessages.recipientUserId), isNull(chatMessages.roomId)))
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
    } else {
      if (!withUserId) return { ok: false, error: 'withUserId required for private mode' };
      rows = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            isNull(chatMessages.deletedAt),
            or(
              and(eq(chatMessages.senderUserId, me.id), eq(chatMessages.recipientUserId, withUserId)),
              and(eq(chatMessages.senderUserId, withUserId), eq(chatMessages.recipientUserId, me.id)),
            ),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
    }

    // reverse to chronological
    rows.reverse();

    const messages: ChatMessageItem[] = rows.map((r: any) => ({
      id: String(r.id),
      senderUserId: String(r.senderUserId),
      senderUsername: String(r.senderUsername),
      recipientUserId: r.recipientUserId == null ? null : String(r.recipientUserId),
      roomId: r.roomId == null ? null : String(r.roomId),
      messageType: r.messageType as any,
      bodyText: r.bodyText == null ? null : String(r.bodyText),
      payload: r.payloadJson ? (() => { try { return JSON.parse(String(r.payloadJson)); } catch { return String(r.payloadJson); } })() : null,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    }));

    return { ok: true, messages };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function chatAdminListPair(
  db: BetterSQLite3Database,
  args: { userAId: string; userBId: string; limit?: number },
): Promise<ChatListResult> {
  try {
    const ok = await canAdminViewAllChats(db);
    if (!ok) return { ok: false, error: 'admin only' };

    const userAId = String(args.userAId ?? '').trim();
    const userBId = String(args.userBId ?? '').trim();
    if (!userAId || !userBId) return { ok: false, error: 'userAId/userBId required' };

    const limit = Math.max(1, Math.min(1000, args.limit ?? 300));

    const rows = await db
      .select()
      .from(chatMessages)
      .where(
        and(
          isNull(chatMessages.deletedAt),
          or(
            and(eq(chatMessages.senderUserId, userAId), eq(chatMessages.recipientUserId, userBId)),
            and(eq(chatMessages.senderUserId, userBId), eq(chatMessages.recipientUserId, userAId)),
          ),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    rows.reverse();

    const messages: ChatMessageItem[] = rows.map((r: any) => ({
      id: String(r.id),
      senderUserId: String(r.senderUserId),
      senderUsername: String(r.senderUsername),
      recipientUserId: r.recipientUserId == null ? null : String(r.recipientUserId),
      messageType: r.messageType as any,
      bodyText: r.bodyText == null ? null : String(r.bodyText),
      payload: r.payloadJson ? (() => { try { return JSON.parse(String(r.payloadJson)); } catch { return String(r.payloadJson); } })() : null,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    }));

    return { ok: true, messages };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function insertMessage(db: BetterSQLite3Database, msg: {
  id: string;
  senderUserId: string;
  senderUsername: string;
  recipientUserId: string | null;
  roomId?: string | null;
  messageType: 'text' | 'file' | 'deep_link' | 'text_notify';
  bodyText: string | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
}) {
  await db.insert(chatMessages).values({ ...msg, roomId: msg.roomId ?? null, syncStatus: 'pending', deletedAt: null });
}

/** Комната, если она видна этому пользователю; иначе `null` — «её для него не существует». */
async function loadVisibleRoom(
  db: BetterSQLite3Database,
  me: { id: string; role: string },
  roomId: string,
): Promise<{ id: string; title: string; ownerUserId: string; membersJson: string | null } | null> {
  const rows = await db.select().from(chatRooms).where(eq(chatRooms.id, roomId)).limit(1);
  const row = rows[0] as any;
  if (!row || row.deletedAt != null) return null;
  const room = {
    id: String(row.id),
    title: String(row.title ?? ''),
    ownerUserId: String(row.ownerUserId ?? ''),
    membersJson: row.membersJson == null ? null : String(row.membersJson),
  };
  const isSuperadmin = String(me.role ?? '').toLowerCase() === 'superadmin';
  return canSeeChatRoom(room, me.id, { isSuperadmin }) ? room : null;
}

/**
 * Комнаты, видимые этому пользователю. Сервер и так не отдаёт чужие строки, но проверяем и
 * здесь: реплика могла застать комнату, из которой оператора потом исключили — удалить у него
 * строку сервер не может, он лишь перестаёт её присылать.
 */
export async function chatRoomsList(db: BetterSQLite3Database): Promise<ChatRoomsListResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const isSuperadmin = String(me.role ?? '').toLowerCase() === 'superadmin';
    const rows = await db.select().from(chatRooms).where(isNull(chatRooms.deletedAt)).limit(5_000);
    const rooms = (rows as any[])
      .map((r) => ({
        id: String(r.id),
        title: String(r.title ?? ''),
        ownerUserId: String(r.ownerUserId ?? ''),
        membersJson: r.membersJson == null ? null : String(r.membersJson),
      }))
      .filter((room) => canSeeChatRoom(room, me.id, { isSuperadmin }))
      .map((room) => ({
        id: room.id,
        title: room.title,
        ownerUserId: room.ownerUserId,
        memberIds: parseRoomMembers(room.membersJson),
        canEdit: canEditChatRoom(room, me.id, { isSuperadmin }),
      }));
    return { ok: true, rooms };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Создать комнату или переписать её название и состав. Правит только создатель. */
export async function chatRoomSave(
  db: BetterSQLite3Database,
  args: { id?: string | null; title: string; memberIds: string[] },
): Promise<ChatRoomSaveResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const title = String(args.title ?? '').trim();
    if (!title) return { ok: false, error: 'название комнаты обязательно' };
    // Создатель в списке участников не хранится — он участник по определению; иначе
    // «убрать себя из своей комнаты» стало бы возможным по недосмотру.
    const memberIds = (args.memberIds ?? []).map((x) => String(x ?? '').trim()).filter((x) => x && x !== me.id);
    const ts = nowMs();
    const id = args.id ? String(args.id) : '';

    if (id) {
      const rows = await db.select().from(chatRooms).where(eq(chatRooms.id, id)).limit(1);
      const row = rows[0] as any;
      if (!row || row.deletedAt != null) return { ok: false, error: 'комната не найдена' };
      const isSuperadmin = String(me.role ?? '').toLowerCase() === 'superadmin';
      if (!canEditChatRoom({ ownerUserId: String(row.ownerUserId ?? '') }, me.id, { isSuperadmin })) {
        return { ok: false, error: 'править комнату может только тот, кто её создал' };
      }
      await db
        .update(chatRooms)
        .set({ title, membersJson: serializeRoomMembers(memberIds), updatedAt: ts, syncStatus: 'pending' })
        .where(eq(chatRooms.id, id));
      return { ok: true, id };
    }

    const newId = randomUUID();
    await db.insert(chatRooms).values({
      id: newId,
      ownerUserId: me.id,
      title,
      membersJson: serializeRoomMembers(memberIds),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    return { ok: true, id: newId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Мягко удалить комнату. Переписка остаётся в базе, но комнаты в списке больше нет. */
export async function chatRoomDelete(db: BetterSQLite3Database, args: { id: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const id = String(args.id ?? '').trim();
    if (!id) return { ok: false, error: 'id required' };
    const rows = await db.select().from(chatRooms).where(eq(chatRooms.id, id)).limit(1);
    const row = rows[0] as any;
    if (!row) return { ok: false, error: 'комната не найдена' };
    if (row.deletedAt != null) return { ok: true };
    const isSuperadmin = String(me.role ?? '').toLowerCase() === 'superadmin';
    if (!canEditChatRoom({ ownerUserId: String(row.ownerUserId ?? '') }, me.id, { isSuperadmin })) {
      return { ok: false, error: 'удалить комнату может только тот, кто её создал' };
    }
    const ts = nowMs();
    await db.update(chatRooms).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(chatRooms.id, id));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function chatSendText(
  db: BetterSQLite3Database,
  args: { recipientUserId?: string | null; roomId?: string | null; text: string },
): Promise<ChatSendResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    const text = String(args.text ?? '').trim();
    if (!text) return { ok: false, error: 'empty message' };
    const roomId = args.roomId ? String(args.roomId) : null;
    // В комнату пишет только её участник. Сервер проверит это ещё раз при приёме посылки:
    // здесь проверка бережёт от ошибки, там — от намерения.
    if (roomId && !(await loadVisibleRoom(db, me, roomId))) return { ok: false, error: 'нет доступа в комнату' };
    const recipientUserId = roomId ? null : args.recipientUserId ? String(args.recipientUserId) : null;

    const ts = nowMs();
    const id = randomUUID();
    await insertMessage(db, {
      id,
      senderUserId: me.id,
      senderUsername: me.username,
      recipientUserId,
      roomId,
      messageType: 'text',
      bodyText: text,
      payloadJson: null,
      createdAt: ts,
      updatedAt: ts,
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function chatSendTextEverywhere(
  db: BetterSQLite3Database,
  args: { recipientUserId?: string | null; text: string },
): Promise<ChatSendResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    const text = String(args.text ?? '').trim();
    if (!text) return { ok: false, error: 'empty message' };
    const recipientUserId = args.recipientUserId ? String(args.recipientUserId) : null;

    const ts = nowMs();
    const id = randomUUID();
    await insertMessage(db, {
      id,
      senderUserId: me.id,
      senderUsername: me.username,
      recipientUserId,
      messageType: 'text_notify',
      bodyText: text,
      payloadJson: null,
      createdAt: ts,
      updatedAt: ts,
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function chatSendDeepLink(
  db: BetterSQLite3Database,
  // `text` — необязательная подпись к ссылке: одно сообщение несёт и текст, и
  // переход на экран (иначе «Правка программы» слала бы две штуки подряд).
  args: { recipientUserId?: string | null; link: ChatDeepLinkPayload; text?: string | null },
): Promise<ChatSendResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    const recipientUserId = args.recipientUserId ? String(args.recipientUserId) : null;
    const payloadJson = JSON.stringify(args.link ?? null);
    const bodyText = String(args.text ?? '').trim().slice(0, 4000) || null;
    const ts = nowMs();
    const id = randomUUID();
    await insertMessage(db, {
      id,
      senderUserId: me.id,
      senderUsername: me.username,
      recipientUserId,
      messageType: 'deep_link',
      bodyText,
      payloadJson,
      createdAt: ts,
      updatedAt: ts,
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function chatDeleteMessage(db: BetterSQLite3Database, args: { messageId: string }): Promise<ChatDeleteResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    const messageId = String(args.messageId ?? '').trim();
    if (!messageId) return { ok: false, error: 'messageId required' };

    const rows = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
    const msg = rows[0] as any;
    if (!msg) return { ok: false, error: 'message not found' };
    if (msg.deletedAt != null) return { ok: true };

    const role = String(me.role ?? '').toLowerCase();
    const isAdmin = role === 'admin' || role === 'superadmin';
    if (!isAdmin && String(msg.senderUserId ?? '') !== me.id) return { ok: false, error: 'not allowed' };

    const ts = nowMs();
    await db.update(chatMessages).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(chatMessages.id, messageId));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

export async function chatSendFile(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { recipientUserId?: string | null; path: string },
): Promise<ChatSendResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    const filePath = String(args.path ?? '').trim();
    if (!filePath) return { ok: false, error: 'path is empty' };
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return { ok: false, error: 'not a file' };
    const size = Number(st.size);
    const max = 20 * 1024 * 1024;
    if (size > max) return { ok: false, error: 'file too large (>20MB)' };

    const name = safeFilename(basename(filePath));
    const sha256 = await sha256OfFile(filePath);

    // Always use Yandex init for chat-files (even for small files), so retention cleanup works by folder.
    const initRes = await httpAuthed(
      db,
      apiBaseUrl,
      '/files/yandex/init',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          size,
          sha256,
          mime: null,
          scope: { ownerType: 'chat', ownerId: 'chat-files', category: 'chat-files' },
        }),
      },
      { timeoutMs: 120_000 },
    );
    if (!initRes.ok) return { ok: false, error: `init HTTP ${initRes.status}` };
    const json = initRes.json as any;
    if (!json?.ok || !json?.file) return { ok: false, error: 'bad init response' };
    const uploadUrl = (json.uploadUrl as string | null) ?? null;
    const file = json.file as any;

    if (uploadUrl) {
      const buf = await fsp.readFile(filePath); // <=20MB
      const r = await net.fetch(uploadUrl, { method: 'PUT', body: buf });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return { ok: false, error: `yandex PUT HTTP ${r.status}: ${t}`.trim() };
      }
    }

    const recipientUserId = args.recipientUserId ? String(args.recipientUserId) : null;
    const ts = nowMs();
    const id = randomUUID();
    await insertMessage(db, {
      id,
      senderUserId: me.id,
      senderUsername: me.username,
      recipientUserId,
      messageType: 'file',
      bodyText: name,
      payloadJson: JSON.stringify(file),
      createdAt: ts,
      updatedAt: ts,
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function chatMarkRead(db: BetterSQLite3Database, args: { messageIds: string[] }): Promise<{ ok: true; marked: number } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    const ids = (args.messageIds ?? []).map((x) => String(x)).filter(Boolean);
    if (ids.length === 0) return { ok: true, marked: 0 };

    const existing = await db
      .select({ messageId: chatReads.messageId })
      .from(chatReads)
      .where(and(eq(chatReads.userId, me.id), inArray(chatReads.messageId, ids)))
      .limit(50_000);
    const seen = new Set(existing.map((r) => String((r as any).messageId)));

    const ts = nowMs();
    const toInsert = ids.filter((id) => !seen.has(id)).map((messageId) => ({
      id: randomUUID(),
      messageId,
      userId: me.id,
      readAt: ts,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    }));

    if (toInsert.length > 0) {
      await db.insert(chatReads).values(toInsert as any);
    }
    return { ok: true, marked: toInsert.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function chatUnreadCount(db: BetterSQLite3Database): Promise<ChatUnreadCountResult> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };

    // Берём и свои отправленные: без них у беседы, где ответа ещё не было, не будет времени
    // последнего сообщения, и она провалится в конец списка как «переписки не было».
    const msgs = await db
      .select({
        id: chatMessages.id,
        senderUserId: chatMessages.senderUserId,
        recipientUserId: chatMessages.recipientUserId,
        roomId: chatMessages.roomId,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          isNull(chatMessages.deletedAt),
          or(
            isNull(chatMessages.recipientUserId),
            eq(chatMessages.recipientUserId, me.id),
            eq(chatMessages.senderUserId, me.id),
          ),
        ),
      )
      .limit(50_000);

    const ids = msgs.map((m) => String((m as any).id));
    if (ids.length === 0) {
      return { ok: true, total: 0, global: 0, byUser: {}, byRoom: {}, lastAt: { global: 0, byUser: {}, byRoom: {} } };
    }

    const reads = await db
      .select({ messageId: chatReads.messageId })
      .from(chatReads)
      .where(and(eq(chatReads.userId, me.id), inArray(chatReads.messageId, ids)))
      .limit(50_000);
    const readSet = new Set(reads.map((r) => String((r as any).messageId)));

    let global = 0;
    const byUser: Record<string, number> = {};
    const byRoom: Record<string, number> = {};
    let lastGlobal = 0;
    const lastByUser: Record<string, number> = {};
    const lastByRoom: Record<string, number> = {};
    const bump = (map: Record<string, number>, key: string, at: number) => {
      if (!key) return;
      if ((map[key] ?? 0) < at) map[key] = at;
    };
    for (const m of msgs as any[]) {
      const id = String(m.id);
      const senderUserId = String(m.senderUserId);
      const recipientUserId = m.recipientUserId == null ? null : String(m.recipientUserId);
      const roomId = m.roomId == null ? null : String(m.roomId);
      const createdAt = Number(m.createdAt ?? 0) || 0;

      // Время беседы считаем по ЛЮБОМУ сообщению, включая своё: «когда здесь last общались».
      if (roomId) bump(lastByRoom, roomId, createdAt);
      else if (!recipientUserId) lastGlobal = Math.max(lastGlobal, createdAt);
      else bump(lastByUser, senderUserId === me.id ? recipientUserId : senderUserId, createdAt);

      if (senderUserId === me.id) continue;
      if (readSet.has(id)) continue;
      if (roomId) byRoom[roomId] = (byRoom[roomId] ?? 0) + 1;
      else if (!recipientUserId) global += 1;
      else byUser[senderUserId] = (byUser[senderUserId] ?? 0) + 1;
    }

    const total =
      global +
      Object.values(byUser).reduce((a, b) => a + b, 0) +
      Object.values(byRoom).reduce((a, b) => a + b, 0);
    return {
      ok: true,
      total,
      global,
      byUser,
      byRoom,
      lastAt: { global: lastGlobal, byUser: lastByUser, byRoom: lastByRoom },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function chatExport(db: BetterSQLite3Database, apiBaseUrl: string, args: { startMs: number; endMs: number }): Promise<ChatExportResult> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, `/chat/export?startMs=${encodeURIComponent(args.startMs)}&endMs=${encodeURIComponent(args.endMs)}`, { method: 'GET' }, { timeoutMs: 120_000 });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok || typeof j.text !== 'string') return { ok: false, error: 'bad response' };

    const suggested = `chat_export_${new Date(args.startMs).toISOString().slice(0, 10)}_${new Date(args.endMs).toISOString().slice(0, 10)}.txt`;
    const saveParent = BrowserWindow.getFocusedWindow();
    const saveOpts = {
      title: 'Экспорт чатов',
      defaultPath: app.getPath('downloads') + '/' + suggested,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    };
    const save = saveParent ? await dialog.showSaveDialog(saveParent, saveOpts) : await dialog.showSaveDialog(saveOpts);
    if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled' };
    await fsp.writeFile(save.filePath, String(j.text), 'utf8');
    return { ok: true, path: save.filePath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

