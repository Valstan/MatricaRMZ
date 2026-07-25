// Политика push-гейта AI-чата (вынесена из applyPushBatch для тестируемости).
// Гейты: владелец = актор; ≤5 новых вопросов/час (не-админам); правки/удаление
// только у pending; ответ/статус/эскалацию клиент не авторит (серверные поля
// затираются из текущей строки); исключение — суперадмин пишет verdict_text
// в escalated-строки. Доверенные записи (рутина/ledger-replay) проходят как есть.

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
  deletedAt?: number | null;
};

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
      // Новый вопрос: владелец всегда актор, статус всегда pending, серверные поля пусты.
      allowed.push({
        ...r,
        user_id: ctx.actorId,
        status: 'pending',
        answer_text: null,
        answer_files_json: null,
        answered_at: null,
        escalation_note: null,
        verdict_text: null,
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
        deleted_at: cur.deletedAt ?? null,
      });
      continue;
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
    });
  }
  return allowed;
}
