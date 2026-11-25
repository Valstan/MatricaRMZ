// Шим 'services/localMiniMaxService.js' для android-бандла (подставляется
// vite-плагином androidShims).
//
// Локальный ИИ-агент (модуль MiniMax на машине оператора) — desktop-фича:
// профиль привязан к каталогу на диске, рантайм запускается дочерним процессом,
// мост к локальной БД — TCP-сокетом. На планшете этого нет, и ставить его некуда.
//
// Шим не выключает ИИ-чат, а переводит его на сервер: `localLinkStatus()` отвечает
// «модуль не настроен», и `aiChat:create` НЕ забирает вопрос себе (claimLocal =
// false) — ответ считает сервер, ровно как на десктопе без локального модуля.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { AiChatLocalStatus } from '@matricarmz/shared';

export function localLinkStatus(): AiChatLocalStatus {
  return {
    state: 'off',
    detail: 'на планшете считает сервер',
    configured: false,
  };
}

/**
 * Локального ответа на планшете не бывает. Вопрос при этом НЕ забирается
 * локально (см. `localLinkStatus`), так что освобождать его не нужно — ответ
 * посчитает сервер.
 */
export async function runLocalAnswer(_params: {
  db: BetterSQLite3Database;
  id: string;
  questionText: string;
  runSync: () => void;
}): Promise<{ ok: boolean; source?: string; reason?: string }> {
  return { ok: false, reason: 'на планшете считает сервер' };
}
