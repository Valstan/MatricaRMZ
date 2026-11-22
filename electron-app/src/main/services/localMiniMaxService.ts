// Клей между локальным звеном и репликой вопросов.
//
// Локальный модуль (services/localMiniMax) считает ответ; этот сервис кладёт его в
// строку вопроса и отпускает вопрос обратно в очередь, если локальное звено не
// справилось (D-243/D-244). Пишет он только автор своего вопроса — тем же путём,
// что и вопрос, поэтому ответ уезжает на сервер и виден на других машинах оператора.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { AiChatLocalStatus } from '@matricarmz/shared';

import { aiChatAnswerLocally, aiChatReleaseQuestion } from './aiChatService.js';
import { createSqliteReader, startLocalDbBridge, type LocalDbBridge } from './localMiniMax/dbBridge.js';
import { answerQuestionLocally, getLocalLinkStatus } from './localMiniMax/localMiniMaxEngine.js';

let bridge: LocalDbBridge | null = null;

/**
 * Мост «реплика → агент» поднимается один раз за сессию: канал одноразовый,
 * имя у него случайное. Если мост не поднялся — агент просто не получит доступ
 * к базе и ответит по вопросу, а программа продолжит работать.
 */
function ensureBridge(db: BetterSQLite3Database): LocalDbBridge | null {
  if (bridge) return bridge;
  const client = (db as unknown as { $client?: unknown }).$client as
    | { prepare(sql: string): { reader: boolean; all(...params: unknown[]): unknown[] } }
    | undefined;
  if (!client || typeof client.prepare !== 'function') return null;
  bridge = startLocalDbBridge(createSqliteReader(client));
  return bridge;
}

/** Статус локального звена для панели ИИваныча. */
export function localLinkStatus(): AiChatLocalStatus {
  return getLocalLinkStatus();
}

/**
 * Считать ответ локально и положить его в строку вопроса.
 *
 * Возвращает, каким звеном посчитан ответ. Ошибка локального звена — не ошибка
 * вопроса: вопрос возвращается в очередь, и его считает сервер.
 */
export async function runLocalAnswer(params: {
  db: BetterSQLite3Database;
  id: string;
  questionText: string;
  /** Пинк синка: без него ответ не уедет на сервер. */
  runSync: () => void;
}): Promise<{ ok: boolean; source?: string; reason?: string }> {
  const outcome = await answerQuestionLocally(params.questionText, { bridge: ensureBridge(params.db) });
  if (!outcome.ok) {
    const released = await aiChatReleaseQuestion(params.db, { id: params.id });
    if (released.ok) params.runSync();
    return { ok: false, reason: outcome.reason };
  }
  const written = await aiChatAnswerLocally(params.db, {
    id: params.id,
    answerText: outcome.answer,
    source: outcome.source,
  });
  if (!written.ok) return { ok: false, reason: written.error };
  params.runSync();
  return { ok: true, source: outcome.source };
}
