/**
 * Комнаты чата и порядок списка бесед (владелец 08.09.2026).
 *
 * Комната — это переписка группы: создатель набирает в неё сотрудников и обсуждает
 * производственные вопросы. Участники хранятся списком идентификаторов В строке комнаты:
 * приглашение — правка одной строки её создателем, и «кто видит комнату» читается одним
 * полем. Отдельная таблица членства дала бы вторую точку правды и гонку «строка комнаты
 * приехала, строки участника ещё нет».
 *
 * Кто видит комнату: создатель, приглашённые и суперадминистратор. Остальные не видят её
 * ВОВСЕ — ни переписки, ни названия. Поэтому проверка живёт здесь, в чистом виде, и её
 * применяют обе стороны: сервер (фильтр выдачи) и клиент (отрисовка списка).
 */

export type ChatRoomRow = {
  id: string;
  title: string;
  ownerUserId: string;
  membersJson?: string | null;
  deletedAt?: number | null;
};

/** Участники комнаты — идентификаторы без создателя (он участник по определению). */
export function parseRoomMembers(membersJson: unknown): string[] {
  if (typeof membersJson !== 'string' || !membersJson.trim()) return [];
  try {
    const raw: unknown = JSON.parse(membersJson);
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
      const id = String(item ?? '').trim();
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

/** Обратная операция: список в строку хранения, без дублей и пустых. */
export function serializeRoomMembers(members: readonly string[]): string {
  const out: string[] = [];
  for (const item of members) {
    const id = String(item ?? '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return JSON.stringify(out);
}

/** Все, кому комната видна: создатель + приглашённые. Суперадминистратор — отдельным правом. */
export function roomParticipantIds(room: Pick<ChatRoomRow, 'ownerUserId' | 'membersJson'>): string[] {
  const owner = String(room.ownerUserId ?? '').trim();
  const members = parseRoomMembers(room.membersJson);
  return owner && !members.includes(owner) ? [owner, ...members] : members;
}

/**
 * Видна ли комната этому пользователю. Не приглашённый не видит даже названия — поэтому
 * ответ `false` означает «строки не существует», а не «есть, но закрыта».
 */
export function canSeeChatRoom(
  room: Pick<ChatRoomRow, 'ownerUserId' | 'membersJson'>,
  userId: string,
  opts?: { isSuperadmin?: boolean },
): boolean {
  if (opts?.isSuperadmin === true) return true;
  const id = String(userId ?? '').trim();
  if (!id) return false;
  return roomParticipantIds(room).includes(id);
}

/** Может ли пользователь править состав и название комнаты. Только создатель. */
export function canEditChatRoom(
  room: Pick<ChatRoomRow, 'ownerUserId'>,
  userId: string,
  opts?: { isSuperadmin?: boolean },
): boolean {
  if (opts?.isSuperadmin === true) return true;
  const id = String(userId ?? '').trim();
  return Boolean(id) && String(room.ownerUserId ?? '').trim() === id;
}

export type ChatConversationOrderItem = {
  /** Время последнего сообщения беседы; 0 или отсутствует — переписки ещё не было. */
  lastMessageAt?: number | null;
  unread?: number;
  title: string;
};

/**
 * Порядок списка бесед: свежая переписка выше (владелец 08.09.2026 — «в котором чате
 * последний раз общался, тот и выше»). Алфавит остаётся только для тех, с кем не
 * переписывались ни разу: между двумя нулями сравнивать нечего, а прыгающий порядок
 * пустых бесед раздражает сильнее, чем их место в списке.
 *
 * Непрочитанное поднимает беседу только внутри «никогда не переписывались»: у беседы с
 * непрочитанным всегда есть свежее сообщение, поэтому первый же ключ уже поставил её выше.
 */
export function compareChatConversations(a: ChatConversationOrderItem, b: ChatConversationOrderItem): number {
  const at = Number(a.lastMessageAt ?? 0) || 0;
  const bt = Number(b.lastMessageAt ?? 0) || 0;
  if (at !== bt) return bt - at;
  const au = Number(a.unread ?? 0) > 0 ? 1 : 0;
  const bu = Number(b.unread ?? 0) > 0 ? 1 : 0;
  if (au !== bu) return bu - au;
  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'ru');
}
