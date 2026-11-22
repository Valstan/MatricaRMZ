// Политика push-гейта AI-чата (вынесена из applyPushBatch для тестируемости).
// Гейты: владелец = актор; ≤5 новых вопросов/час (не-админам); правки/удаление
// только у pending; ответ/статус/эскалацию клиент не авторит (серверные поля
// затираются из текущей строки); исключение — суперадмин пишет verdict_text
// в escalated-строки. Доверенные записи (рутина/ledger-replay) проходят как есть.
//
// Локальное звено на клиенте (D-243/D-244, 22.11.2026): автор своего вопроса
// может взять его в работу сам (claim) и положить ответ, посчитанный его
// компьютером. Без этой ветки серверный воркер ответил бы вторым — и заплатил
// DeepSeek за тот же вопрос.

export type AiChatPushRow = {
  id: string;
  user_id: string;
  username: string;
  question_text: string;
  question_file_json?: string | null;
  status: string;
  answer_text?: string | null;
  answer_files_json?: string | null;
  answered_at?: number | null;
  escalation_note?: string | null;
  verdict_text?: string | null;
  answer_source?: 'engine' | 'deepseek' | 'local_minimax' | 'deepseek_client' | null;
  deleted_at?: number | null;
  [key: string]: unknown;
};

export type AiChatExistingRow = {
  userId: string;
  username: string;
  questionText: string;
  questionFileJson?: string | null;
  status: string;
  answerText?: string | null;
  answerFilesJson?: string | null;
  answeredAt?: number | null;
  escalationNote?: string | null;
  answerSource?: 'engine' | 'deepseek' | 'local_minimax' | 'deepseek_client' | null;
  deletedAt?: number | null;
};

/**
 * Ответ клиентского локального звена: непустой текст + источник из клиентских
 * (`local_minimax`, `deepseek_client`). Пустой ответ или серверный источник сюда
 * не проходят — это обычное серверное поле.
 */
function clientAnswerFields(r: AiChatPushRow): {
  answerText: string;
  answerSource: 'local_minimax' | 'deepseek_client';
  answeredAt: number;
} | null {
  const source = typeof r.answer_source === 'string' ? r.answer_source : null;
  if (source !== 'local_minimax' && source !== 'deepseek_client') return null;
  const answerText = typeof r.answer_text === 'string' ? r.answer_text.trim() : '';
  if (!answerText) return null;
  const answeredAt = typeof r.answered_at === 'number' ? r.answered_at : Date.now();
  return { answerText, answerSource: source, answeredAt };
}

export function applyAiChatPushPolicy(
  rows: AiChatPushRow[],
  existingMap: Map<string, AiChatExistingRow>,
  ctx: {
    actorId: string;
    trustedServerWrite: boolean;
    actorIsAdmin: boolean;
    actorIsSuperadmin: boolean;
    /** Существующие вопросы актора за последний час (посчитаны в той же транзакции). */
    initialHourCount: number;
  },
): AiChatPushRow[] {
  let hourCount = ctx.initialHourCount;
  const allowed: AiChatPushRow[] = [];
  for (const r of rows) {
    if (ctx.trustedServerWrite) {
      allowed.push(r);
      continue;
    }
    const cur = existingMap.get(String(r.id));
    if (!cur) {
      hourCount += 1;
      if (hourCount > 5 && !ctx.actorIsAdmin) throw new Error('sync_policy_denied: ai_chat_rate_limit');
      // Новый вопрос: владелец всегда актор, серверные поля пусты. Статус 'processing'
      // — это claim клиента: вопрос считает его компьютер, серверный воркер такую
      // строку не берёт (он берёт только 'pending'). Если клиент умрёт, строку вернёт
      // в очередь серверный reclaimStale (10 минут без движения).
      allowed.push({
        ...r,
        user_id: ctx.actorId,
        status: r.status === 'processing' ? 'processing' : 'pending',
        answer_text: null,
        answer_files_json: null,
        answered_at: null,
        escalation_note: null,
        verdict_text: null,
        answer_source: null,
      });
      continue;
    }
    const isOwner = String(cur.userId ?? '') === ctx.actorId;
    if (!isOwner && !ctx.actorIsAdmin) throw new Error('sync_policy_denied: ai_chat_owner');
    const curStatus = String(cur.status ?? 'pending');
    if (ctx.actorIsSuperadmin && curStatus === 'escalated') {
      // Суперадмин: только вердикт, остальное — из текущей строки.
      allowed.push({
        ...r,
        user_id: String(cur.userId),
        username: String(cur.username),
        question_text: String(cur.questionText),
        question_file_json: cur.questionFileJson ?? null,
        status: curStatus,
        answer_text: cur.answerText ?? null,
        answer_files_json: cur.answerFilesJson ?? null,
        answered_at: cur.answeredAt ?? null,
        escalation_note: cur.escalationNote ?? null,
        answer_source: cur.answerSource ?? null,
        deleted_at: cur.deletedAt ?? null,
      });
      continue;
    }
    if (isOwner && curStatus === 'processing') {
      // Claim клиента: автор своего вопроса либо кладёт ответ, посчитанный его
      // компьютером, либо отпускает вопрос обратно в очередь (локальное звено
      // не справилось — ответит сервер). Чужие строки сюда не попадают.
      const clientAnswer = clientAnswerFields(r);
      if (clientAnswer && r.status === 'answered') {
        allowed.push({
          ...r,
          user_id: String(cur.userId),
          username: String(cur.username),
          question_text: String(cur.questionText),
          question_file_json: cur.questionFileJson ?? null,
          status: 'answered',
          answer_text: clientAnswer.answerText,
          answer_files_json: null,
          answered_at: clientAnswer.answeredAt,
          escalation_note: null,
          verdict_text: null,
          answer_source: clientAnswer.answerSource,
          deleted_at: cur.deletedAt ?? null,
        });
        continue;
      }
      if (r.status === 'pending') {
        allowed.push({
          ...r,
          user_id: String(cur.userId),
          username: String(cur.username),
          question_text: String(cur.questionText),
          question_file_json: cur.questionFileJson ?? null,
          status: 'pending',
          answer_text: null,
          answer_files_json: null,
          answered_at: null,
          escalation_note: null,
          verdict_text: null,
          answer_source: null,
          deleted_at: cur.deletedAt ?? null,
        });
        continue;
      }
    }
    if (curStatus !== 'pending') throw new Error('sync_policy_denied: ai_chat_not_pending');
    // Владелец правит/удаляет свой pending-вопрос; серверные поля не трогает.
    allowed.push({
      ...r,
      user_id: String(cur.userId),
      status: 'pending',
      answer_text: null,
      answer_files_json: null,
      answered_at: null,
      escalation_note: null,
      verdict_text: null,
      answer_source: null,
    });
  }
  return allowed;
}
