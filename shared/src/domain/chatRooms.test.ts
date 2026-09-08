import { describe, expect, it } from 'vitest';

import {
  canEditChatRoom,
  canSeeChatRoom,
  compareChatConversations,
  parseRoomMembers,
  roomParticipantIds,
  serializeRoomMembers,
} from './chatRooms.js';

const OWNER = 'u-owner';
const GUEST = 'u-guest';
const STRANGER = 'u-stranger';

describe('состав комнаты', () => {
  it('разбирает список участников и переживает мусор', () => {
    expect(parseRoomMembers(JSON.stringify([GUEST, GUEST, ' ']))).toEqual([GUEST]);
    expect(parseRoomMembers('не json')).toEqual([]);
    expect(parseRoomMembers(null)).toEqual([]);
    expect(parseRoomMembers(JSON.stringify({ a: 1 })), 'объект — не список участников').toEqual([]);
  });

  it('создатель — участник по определению, даже если его нет в списке', () => {
    expect(roomParticipantIds({ ownerUserId: OWNER, membersJson: JSON.stringify([GUEST]) })).toEqual([OWNER, GUEST]);
  });

  it('сохраняет состав без дублей и пустых', () => {
    expect(serializeRoomMembers([GUEST, GUEST, '', ' '])).toBe(JSON.stringify([GUEST]));
  });
});

describe('кто видит комнату', () => {
  const room = { ownerUserId: OWNER, membersJson: JSON.stringify([GUEST]) };

  it('создатель и приглашённый — видят', () => {
    expect(canSeeChatRoom(room, OWNER)).toBe(true);
    expect(canSeeChatRoom(room, GUEST)).toBe(true);
  });

  it('посторонний не видит комнату вовсе', () => {
    // Не «видит, но закрыта»: для него строки комнаты не существует, включая название.
    expect(canSeeChatRoom(room, STRANGER)).toBe(false);
  });

  it('суперадминистратор видит любую комнату', () => {
    expect(canSeeChatRoom(room, STRANGER, { isSuperadmin: true })).toBe(true);
  });

  it('пустой пользователь не видит ничего', () => {
    expect(canSeeChatRoom(room, '')).toBe(false);
  });

  it('править состав может только создатель', () => {
    expect(canEditChatRoom(room, OWNER)).toBe(true);
    expect(canEditChatRoom(room, GUEST)).toBe(false);
    expect(canEditChatRoom(room, GUEST, { isSuperadmin: true })).toBe(true);
  });
});

describe('порядок списка бесед', () => {
  it('свежая переписка выше', () => {
    const items = [
      { title: 'Старая', lastMessageAt: 100 },
      { title: 'Свежая', lastMessageAt: 900 },
      { title: 'Средняя', lastMessageAt: 500 },
    ];
    expect([...items].sort(compareChatConversations).map((x) => x.title)).toEqual(['Свежая', 'Средняя', 'Старая']);
  });

  it('беседы без переписки уходят вниз и там сортируются по алфавиту', () => {
    const items = [
      { title: 'Яковлев' },
      { title: 'Абрамов' },
      { title: 'С кем говорили', lastMessageAt: 5 },
    ];
    expect([...items].sort(compareChatConversations).map((x) => x.title)).toEqual([
      'С кем говорили',
      'Абрамов',
      'Яковлев',
    ]);
  });

  it('непрочитанное поднимает только среди беспереписочных', () => {
    // У беседы с непрочитанным есть свежее сообщение, поэтому обычно её поднимает первый ключ.
    const items = [
      { title: 'Тихий', lastMessageAt: 0, unread: 0 },
      { title: 'Ждёт ответа', lastMessageAt: 0, unread: 3 },
    ];
    expect([...items].sort(compareChatConversations).map((x) => x.title)).toEqual(['Ждёт ответа', 'Тихий']);
  });
});
