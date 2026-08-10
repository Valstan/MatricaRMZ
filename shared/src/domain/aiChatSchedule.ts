// Расписание облачной AI-рутины асинхронного чата: Пн–Пт, ежечасно в :00,
// с 8:00 до 17:00 МСК включительно. МСК — фиксированный UTC+3, без DST.
// Клиент считает баннер «когда ответит ИИ» локально этим helper'ом (офлайн-совместимо).
//
// Чаще раза в час платформа рутину запускать не даёт («minimum interval is 1 hour»),
// поэтому прогон не завершается после первой пачки, а ~50 минут дренажит очередь,
// штампуя /mark-run каждые ~2.5 мин. Свежий штамп = рутина сейчас на связи и ответит
// за минуты, а не в следующий слот — это и показывает `isAiRoutineLive`.

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const AI_CHAT_RUN_HOUR_FIRST = 8; // первый запуск 8:00 МСК
export const AI_CHAT_RUN_HOUR_LAST = 17; // последний запуск 17:00 МСК
export const AI_CHAT_MAX_QUESTIONS_PER_HOUR = 5;

/** Пульс дренажа — ~2.5 мин; допускаем пропуск пары штампов и расхождение часов. */
export const AI_CHAT_PULSE_STALE_MS = 6 * 60 * 1000;

/**
 * Рутина прямо сейчас разбирает очередь (жива в дренаже)?
 * `lastRunAt` — серверный штамп, `now` — локальные часы клиента: при заметном расхождении
 * (штамп «из будущего» или слишком старый) честно отвечаем false и баннер падает обратно
 * на расписание — это безопасная сторона ошибки.
 */
export function isAiRoutineLive(lastRunAt: number | null, now: number): boolean {
  if (lastRunAt == null) return false;
  const age = now - lastRunAt;
  return age >= 0 && age < AI_CHAT_PULSE_STALE_MS;
}

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

export type AiChatRequestStatus = 'pending' | 'processing' | 'answered' | 'escalated' | 'rejected';

export const AI_CHAT_STATUS_LABELS: Record<AiChatRequestStatus, string> = {
  pending: '⏳ ожидает ответа',
  processing: '🤔 ИИваныч думает',
  answered: '✅ отвечен',
  escalated: '⚠️ на рассмотрении',
  rejected: '🚫 отклонён',
};

/** Вопрос ещё в работе — клиент показывает «думает» и опрашивает чаще обычного. */
export function isAiChatInFlight(status: AiChatRequestStatus): boolean {
  return status === 'pending' || status === 'processing';
}

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

/** Состояние движка ИИваныча, как его видит сервер (роут `/ai-chat/meta`). */
export type AiChatEngineMeta = {
  /** `direct` — сервер отвечает сам через API нейросети; `routine` — ждём облачную рутину. */
  mode: 'direct' | 'routine';
  /** Ключ движка настроен и ИИваныч включён — можно обещать ответ «прямо сейчас». */
  ready: boolean;
  /** Штамп последнего прогона облачной рутины (в direct-режиме не используется). */
  lastRunAt: number | null;
};

export type AiChatMetaResult = ({ ok: true } & AiChatEngineMeta) | { ok: false; error: string };
