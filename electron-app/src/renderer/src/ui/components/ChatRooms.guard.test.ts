import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Комнаты чата (владелец 08.09.2026). Правила чистые и покрыты `chatRooms.test.ts`, а рвётся
// провод — и рвётся молча: комната отрисуется, сообщения отправятся, но уедут не туда или
// достанутся не тем. Сторож держит четыре стыка: приватность выдачи (сервер), проверку
// участника при записи (сервер), адрес сообщения (клиент) и порядок списка бесед (UI).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PANEL = src('./ChatPanel.tsx');
const SERVICE = src('../../../../main/services/chatService.ts');
const IPC = src('../../../../main/ipc/register/chat.ts');
const PRELOAD = src('../../../../preload/index.ts');
const PRIVACY = src('../../../../../../backend-api/src/services/sync/syncPrivacy.ts');
const PUSH = src('../../../../../../backend-api/src/services/sync/applyPushBatch.ts');

describe('сервер не отдаёт комнату посторонним', () => {
  it('комнаты — приватная таблица, и её строки фильтруются', () => {
    expect(PRIVACY).toContain('SyncTableName.ChatRooms');
    expect(PRIVACY).toContain('case SyncTableName.ChatRooms:');
    expect(PRIVACY, 'построчный фильтр снимка обязан знать про комнаты').toContain(
      "return ctx.visibleRoomIds.has(String(row['id'] ?? ''));",
    );
  });

  it('сообщение комнаты не считается широковещательным', () => {
    // Иначе оно уехало бы всем: у сообщения комнаты адресата-человека нет.
    expect(PRIVACY).toContain('conditions.push(and(isNull(pgTable.recipientUserId), isNull(pgTable.roomId)));');
    expect(PRIVACY).toContain("const roomId = String(row['room_id'] ?? '');");
    expect(PRIVACY).toContain('if (roomId) return ctx.visibleRoomIds.has(roomId);');
  });

  it('админ комнаты не обходит — только суперадминистратор', () => {
    expect(PRIVACY).toContain('export function adminRoomFilterForTable');
    expect(PRIVACY).toContain('if (actor.isSuperadmin === true) return true;');
  });

  it('точную принадлежность считает общий доменный предикат, а не LIKE', () => {
    expect(PRIVACY).toContain('canSeeChatRoom(');
    expect(PRIVACY).toContain('export async function getVisibleChatRoomIds');
  });
});

describe('сервер не принимает чужую запись', () => {
  it('править комнату может только её создатель', () => {
    expect(PUSH).toContain("throw new Error('sync_policy_denied: chat_room_owner');");
    expect(PUSH, 'создателем становится приславший, что бы ни было в поле').toContain('allowed.push({ ...r, owner_user_id: actorId });');
  });

  it('писать в комнату может только участник', () => {
    expect(PUSH).toContain("throw new Error('sync_policy_denied: chat_room_member');");
    expect(PUSH).toContain('canSeeChatRoom(');
  });

  it('адрес комнаты доезжает до строки сообщения', () => {
    expect(PUSH).toContain('roomId: r.room_id ? (r.room_id as any) : null,');
    expect(PUSH).toContain('roomId: sql`excluded.room_id`,');
  });
});

describe('клиент шлёт и читает по адресу комнаты', () => {
  it('в комнату пишет только тот, кому она видна', () => {
    expect(SERVICE).toContain('async function loadVisibleRoom(');
    expect(SERVICE).toContain("if (roomId && !(await loadVisibleRoom(db, me, roomId))) return { ok: false, error: 'нет доступа в комнату' };");
  });

  it('общий чат — это отсутствие ОБОИХ адресов', () => {
    expect(SERVICE, 'без проверки room_id общий чат показал бы переписку комнат').toContain(
      'and(isNull(chatMessages.deletedAt), isNull(chatMessages.recipientUserId), isNull(chatMessages.roomId))',
    );
  });

  it('мост и IPC отдают комнаты в интерфейс', () => {
    expect(IPC).toContain("ipcMain.handle('chat:roomsList'");
    expect(IPC).toContain("ipcMain.handle('chat:roomSave'");
    expect(IPC).toContain("ipcMain.handle('chat:roomDelete'");
    expect(PRELOAD).toContain("roomsList: async () => ipcRenderer.invoke('chat:roomsList'),");
  });
});

describe('список бесед', () => {
  it('порядок — по свежести переписки, а не по алфавиту', () => {
    expect(PANEL).toContain('compareChatConversations');
    expect(PANEL, 'прежняя сортировка по алфавиту вернула бы старое поведение').not.toContain(
      "return a.title.localeCompare(b.title, 'ru');",
    );
    expect(SERVICE, 'без времени последнего сообщения сортировать нечем').toContain('lastAt: { global: lastGlobal, byUser: lastByUser, byRoom: lastByRoom }');
  });

  it('комнаты стоят в общем списке, а не отдельной группой', () => {
    expect(PANEL).toContain('const all = [...general, ...roomItems, ...people].sort(compareChatConversations);');
    expect(PANEL).toContain('data-chat-room-create');
    expect(PANEL).toContain('data-chat-room-dialog');
  });

  it('исключённого из комнаты уводит с неё, а не оставляет на мёртвой переписке', () => {
    expect(PANEL).toContain('if (rooms.some((r) => r.id === selectedRoomId)) return;');
  });
});
