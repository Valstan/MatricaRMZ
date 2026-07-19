// Расписание облачной AI-рутины асинхронного чата: Пн–Пт, ежечасно в :00,
// с 8:00 до 17:00 МСК включительно. МСК — фиксированный UTC+3, без DST.
// Клиент считает баннер «когда ответит ИИ» локально этим helper'ом (офлайн-совместимо).

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const AI_CHAT_RUN_HOUR_FIRST = 8; // первый запуск 8:00 МСК
export const AI_CHAT_RUN_HOUR_LAST = 17; // последний запуск 17:00 МСК
export const AI_CHAT_MAX_QUESTIONS_PER_HOUR = 5;

function isRunSlot(mskMs: number): boolean {
  const d = new Date(mskMs);
  const dow = d.getUTCDay(); // по МСК-сдвинутому времени
  if (dow === 0 || dow === 6) return false; // Вс / Сб
  const h = d.getUTCHours();
  return h >= AI_CHAT_RUN_HOUR_FIRST && h <= AI_CHAT_RUN_HOUR_LAST;
}

/** Ближайший запуск рутины СТРОГО ПОСЛЕ `now` (ms epoch). */
export function getNextAiRunAt(now: number): number {
  // Работаем в «МСК-времени»: сдвигаем и используем UTC-геттеры.
  let msk = now + MSK_OFFSET_MS;
  // следующий целый час
  msk = Math.floor(msk / HOUR_MS) * HOUR_MS + HOUR_MS;
  // максимум неделя поиска с запасом
  for (let i = 0; i < 24 * 8; i++) {
    if (isRunSlot(msk)) return msk - MSK_OFFSET_MS;
    msk += HOUR_MS;
  }
  return now; // недостижимо
}

/** Последний запуск рутины НЕ ПОЗЖЕ `now` (ms epoch). */
export function getPrevAiRunAt(now: number): number {
  let msk = Math.floor((now + MSK_OFFSET_MS) / HOUR_MS) * HOUR_MS;
  for (let i = 0; i < 24 * 8; i++) {
    if (isRunSlot(msk)) return msk - MSK_OFFSET_MS;
    msk -= HOUR_MS;
  }
  return now; // недостижимо
}

export type AiChatRequestStatus = 'pending' | 'answered' | 'escalated' | 'rejected';

export const AI_CHAT_STATUS_LABELS: Record<AiChatRequestStatus, string> = {
  pending: '⏳ ожидает ответа',
  answered: '✅ отвечен',
  escalated: '⚠️ на рассмотрении',
  rejected: '🚫 отклонён',
};

/** Строка ai_chat_requests в форме клиента (camelCase, как в SQLite-реплике). */
export type AiChatRequestItem = {
  id: string;
  userId: string;
  username: string;
  questionText: string;
  questionFileJson: string | null;
  status: AiChatRequestStatus;
  answerText: string | null;
  answerFilesJson: string | null;
  answeredAt: number | null;
  escalationNote: string | null;
  verdictText: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type AiChatMetaResult =
  | { ok: true; lastRunAt: number | null }
  | { ok: false; error: string };
