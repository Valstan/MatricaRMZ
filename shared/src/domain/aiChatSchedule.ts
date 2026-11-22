// Асинхронный AI-чат (ИИваныч): статусы очереди вопросов и лимит на пользователя.
// Расписание облачной рутины отсюда снято вместе с самой рутиной (D-024): сервер
// отвечает прямым вызовом нейросети, поэтому «когда ответит» больше не вычисляется —
// ответ идёт сразу, а прогресс виден по статусу вопроса.

export const AI_CHAT_MAX_QUESTIONS_PER_HOUR = 5;

export type AiChatRequestStatus = 'pending' | 'processing' | 'answered' | 'escalated' | 'rejected';

/**
 * Какое звено цепочки посчитало ответ.
 *
 * - `engine` — движок завода на проде (MiniMax-воркер, D-243);
 * - `deepseek` — платный DeepSeek на проде: последнее страховочное звено;
 * - `local_minimax` — локальный MiniMax на машине оператора (D-243/D-244);
 * - `deepseek_client` — DeepSeek, вызванный прямо с машины оператора (ключ клиентский).
 */
export type AiChatAnswerSource = 'engine' | 'deepseek' | 'local_minimax' | 'deepseek_client';

/** Источники, которые пишет клиент своим локальным звеном (сервер их не пишет). */
export const CLIENT_ANSWER_SOURCES: readonly AiChatAnswerSource[] = ['local_minimax', 'deepseek_client'];

export function isClientAnswerSource(source: string | null | undefined): source is AiChatAnswerSource {
  return !!source && (CLIENT_ANSWER_SOURCES as readonly string[]).includes(source);
}

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
  /**
   * Какое звено цепочки посчитало ответ (`answer_source` из строки).
   * Приходит серверу и всем клиентам: `engine` — движок завода, `deepseek` —
   * последнее звено, `local_minimax` — локальный MiniMax на машине оператора,
   * `deepseek_client` — DeepSeek, вызванный с машины оператора. null — строка
   * ещё не отвечена, отвечена человеком или отвечена до появления поля.
   */
  serverAnswerSource?: AiChatAnswerSource | null;
};

/**
 * Пометка источника ответа для оператора. Локальное звено на клиенте появилось
 * 22.11.2026 (D-243/D-244): ответ может посчитать этот компьютер, резерв с
 * этого компьютера или сервер.
 */
export function formatAiChatAnswerSourceLabel(item: Pick<AiChatRequestItem, 'serverAnswerSource'>): string {
  if (item.serverAnswerSource === 'local_minimax') return 'считал этот компьютер';
  if (item.serverAnswerSource === 'deepseek_client') return 'считал резерв с этого компьютера';
  if (item.serverAnswerSource === 'engine') return 'считал движок завода';
  if (item.serverAnswerSource === 'deepseek') return 'считал резервный движок';
  return 'считал сервер';
}

/**
 * Состояние локального звена на машине оператора — для строки статуса в панели.
 *
 * - `off` — модуль не настроен (нет токена/рантайма): считает сервер;
 * - `ready` — модуль готов, аккаунт пула есть;
 * - `working` — модуль сейчас считает ответ;
 * - `no_accounts` — пул аккаунтов исчерпан (это ёмкость, а не поломка);
 * - `broken` — модуль настроен, но не работает (сломан рантайм/профиль).
 */
export type AiChatLocalLinkState = 'off' | 'ready' | 'working' | 'no_accounts' | 'broken';

export type AiChatLocalStatus = {
  state: AiChatLocalLinkState;
  /** Человекочитаемая причина — одной строкой, без технических кодов. */
  detail: string;
  /** Токен комнаты «Кармана» на месте — иначе звено не включится. */
  configured: boolean;
};

export const AI_CHAT_LOCAL_STATE_LABELS: Record<AiChatLocalLinkState, string> = {
  off: '🔵 считает сервер',
  ready: '🟢 считает этот компьютер',
  working: '🟡 считает этот компьютер',
  no_accounts: '🟠 аккаунты кончились — считает сервер',
  broken: '🔴 локальный модуль не работает — считает сервер',
};

/** Состояние движка ИИваныча, как его видит сервер (роут `/ai-chat/meta`). */
export type AiChatEngineMeta = {
  /** Ключ движка настроен и ИИваныч включён — можно обещать ответ «прямо сейчас». */
  ready: boolean;
};

export type AiChatMetaResult = ({ ok: true } & AiChatEngineMeta) | { ok: false; error: string };
