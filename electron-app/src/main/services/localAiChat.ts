import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { aiChatRequests } from '../database/schema.js';
import { askLocalEngine } from './localEngineSession.js';

/**
 * Ответ локального движка (контур B). Строка очереди уже лежит в базе с
 * `syncStatus: 'synced'` — на сервер она не уходит, поэтому и ответ пишем
 * только здесь. Ошибку показываем текстом ответа: оператору важно видеть, что
 * именно не получилось, а не «ждёт ответа» навсегда.
 */
export async function runLocalAiChatAnswer(
  db: BetterSQLite3Database,
  id: string,
  questionText: string,
): Promise<void> {
  const res = await askLocalEngine(questionText);
  const answerText = res.ok ? res.text : `⚠️ Локальный движок не ответил: ${res.error}`;
  const ts = Date.now();
  try {
    await db
      .update(aiChatRequests)
      .set({ status: 'answered', answerText, answeredAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(aiChatRequests.id, id));
  } catch {
    // строку могли удалить, пока движок думал
  }
}
