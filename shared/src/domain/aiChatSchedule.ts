// Асинхронный AI-чат (ИИваныч): статусы очереди вопросов и лимит на пользователя.
// Расписание облачной рутины отсюда снято вместе с самой рутиной (D-024): сервер
// отвечает прямым вызовом нейросети, поэтому «когда ответит» больше не вычисляется —
// ответ идёт сразу, а прогресс виден по статусу вопроса.

export const AI_CHAT_MAX_QUESTIONS_PER_HOUR = 5;

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
  /** Ключ движка настроен и ИИваныч включён — можно обещать ответ «прямо сейчас». */
  ready: boolean;
};

export type AiChatMetaResult = ({ ok: true } & AiChatEngineMeta) | { ok: false; error: string };
