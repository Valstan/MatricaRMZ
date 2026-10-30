// Протокол между main и процессом чтения данных (`utilityProcess`).
//
// Зачем второй воркер: `better-sqlite3` синхронный, поэтому тяжёлые чтения в главном
// процессе останавливают окно ровно на свою длительность. Синк уехал в свой процесс
// (PR-2 плана `client-ram-cache-and-sync-worker-2026-10.md`), а сборка списка двигателей
// осталась в main и на слабых машинах держит поток 1.8–16 с. Здесь — тот же приём для
// чтений: список собирается в отдельном процессе, main остаётся брокером.
//
// Модуль без node/electron-импортов: его тянут оба процесса и тесты прокси.
import type { EngineListItem } from '@matricarmz/shared';

/** Имя входного файла воркера в `dist/main` (см. `electron.vite.config.ts`). */
export const DATA_WORKER_ENTRY = 'dataWorker.js';

export type DataWorkerInit = {
  type: 'init';
  dbPath: string;
  /** Ключ SQLCipher. Идёт сообщением внутри процесса, на диск и в argv не попадает. */
  dbKey: string | null;
  /** Каталог приложения: лог пишется туда же, где у main. */
  userDataPath: string;
};

export type DataWorkerRequest =
  | DataWorkerInit
  /** Прогрев кэшей списка в фоне: первый клик оператора не должен строить их сам. */
  | { type: 'warm' }
  | { type: 'engineList'; reqId: string }
  | { type: 'close' };

/**
 * Фазы замера едут вместе со строками: журнал `slow engine:list` пишет main, и без них
 * он потерял бы ровно то, чем этот переезд и обоснован, — видно, что именно читалось.
 */
export type DataWorkerEngineListResult = {
  type: 'engineList:result';
  reqId: string;
  rows: EngineListItem[];
  phases: Record<string, number>;
  ms: number;
};

export type DataWorkerResponse =
  | { type: 'ready' }
  | DataWorkerEngineListResult
  | { type: 'engineList:failed'; reqId: string; error: string }
  | { type: 'fatal'; error: string }
  | { type: 'closed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

export function isDataWorkerResponse(message: unknown): message is DataWorkerResponse {
  return isRecord(message) && typeof message.type === 'string';
}
