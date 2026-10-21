import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { AiAnswerSource, AiEngineMode } from '@matricarmz/shared';

import { aiChatRequests } from '../database/schema.js';
import { askLocalWithBreaker, markAnswerSource } from './aiEngineAuto.js';

/**
 * Ответ локального движка (контур B) и откат на сервер.
 *
 * В режиме «Только этот ПК» строка лежит с `syncStatus: 'synced'` — на сервер
 * вопрос не уходит, и неудача видна оператору текстом ответа.
 *
 * В режиме «Авто» строка тоже создаётся локальной, но при неудаче движка мы
 * переводим её в `pending` — тогда вопрос уходит на сервер и ответ приезжает
 * оттуда. Оператор при этом видит, где посчитано («считал сервер»).
 */
export async function runLocalAiChatAnswer(
  db: BetterSQLite3Database,
  id: string,
  questionText: string,
  opts?: { mode?: AiEngineMode; onFallback?: () => void },
): Promise<{ ok: boolean; error?: string; source: AiAnswerSource }> {
  const mode = opts?.mode ?? 'local';
  const res = await askLocalWithBreaker(mode, questionText);
  const ts = Date.now();
  if (res.ok) {
    markAnswerSource(id, 'local');
    try {
      await db
        .update(aiChatRequests)
        .set({ status: 'answered', answerText: res.text, answeredAt: ts, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(aiChatRequests.id, id));
    } catch {
      // строку могли удалить, пока движок думал
    }
    return { ok: true, source: 'local' };
  }

  if (mode === 'local') {
    // Строго «этот ПК»: серверу не отдаём, показываем оператору причину.
    const answerText = `⚠️ Локальный движок не ответил: ${res.error ?? 'неизвестная ошибка'}`;
    markAnswerSource(id, 'local');
    try {
      await db
        .update(aiChatRequests)
        .set({ status: 'answered', answerText, answeredAt: ts, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(aiChatRequests.id, id));
    } catch {
      // строку могли удалить
    }
    return { ok: false, error: res.error ?? 'неизвестная ошибка', source: 'local' };
  }

  // «Авто»: отдаём вопрос серверу — пусть отвечает он.
  markAnswerSource(id, 'server');
  try {
    await db
      .update(aiChatRequests)
      .set({ status: 'pending', updatedAt: ts, syncStatus: 'pending' })
      .where(eq(aiChatRequests.id, id));
  } catch {
    // строку могли удалить — тогда и откатываться нечего
    return { ok: false, error: res.error ?? 'неизвестная ошибка', source: 'server' };
  }
  try {
    opts?.onFallback?.();
  } catch {
    // пинок синка — best-effort
  }
  return { ok: false, error: res.error ?? 'неизвестная ошибка', source: 'server' };
}
