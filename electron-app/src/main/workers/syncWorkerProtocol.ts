// Протокол между main и процессом синка. Сообщения идут по одному порту
// (`utilityProcess`/`process.parentPort`) в обе стороны, поэтому здесь описаны обе
// стороны разговора: заявки main → воркер и обратные вызовы (сессия живёт в main —
// только там есть безопасное хранилище ключей).
//
// Модуль без node/electron-импортов: его тянут оба процесса и тесты прокси.
import type { SyncRunResult, SyncStatus } from '@matricarmz/shared';

import type { SyncRefreshOutcome, SyncSessionView } from '../services/syncSession.js';

/** Имя входного файла воркера в `dist/main` (см. `electron.vite.config.ts`). */
export const SYNC_WORKER_ENTRY = 'syncWorker.js';

/**
 * Прогресс прогона в том виде, в каком он пересекает порт. Колбэки функциями не
 * передаются: прогресс всегда уходит в окна (`sync:progress`) из main, поэтому
 * воркер сам подставляет свой эмиттер. Здесь остаётся только то, что влияет на текст
 * события, — режим и точка отсчёта.
 */
export type SyncWireRunOpts = {
  mode: 'incremental' | 'force_full_pull';
  startedAt?: number;
  fullPull?: { reason: 'force_full_pull'; startedAt: number; estimateMs: number };
};

export type SyncWorkerInit = {
  type: 'init';
  dbPath: string;
  /** Каталог приложения: лог и pending-export живут там же, где у main. */
  userDataPath: string;
  /** Версия приложения: по ней сервер решает, какой снимок схемы отдавать. */
  appVersion: string;
  /** Ключ SQLCipher. Идёт сообщением внутри процесса, на диск не попадает. */
  dbKey: string | null;
  clientId: string;
  apiBaseUrl: string;
  /** Интервал страховочного тика; null — автосинк не запускать. */
  autoSyncMs: number | null;
};

export type SyncWorkerRequest =
  | SyncWorkerInit
  | { type: 'run'; reqId: string; opts: SyncWireRunOpts }
  | { type: 'setApiBaseUrl'; apiBaseUrl: string }
  | { type: 'startAuto'; intervalMs: number }
  | { type: 'stopAuto' }
  | { type: 'close' };

/** Статус в плоском виде: `nextAutoSyncInMs` считает уже main, по абсолютному времени. */
export type SyncWireStatus = {
  state: SyncStatus['state'];
  lastSyncAt: number | null;
  lastError: string | null;
  lastResult: SyncRunResult | null;
  nextAutoSyncAt: number | null;
  apiBaseUrl: string;
};

/** Ответы воркера на заявки main. */
export type SyncWorkerResponse =
  | { type: 'ready' }
  | { type: 'status'; status: SyncWireStatus }
  | { type: 'progress'; payload: unknown }
  | { type: 'runResult'; reqId: string; result: SyncRunResult }
  | { type: 'runFailed'; reqId: string; error: string }
  | { type: 'fatal'; error: string }
  | { type: 'closed' };

/** Запросы воркера в main: расшифровать сессию здесь невозможно. */
export type SyncWorkerCall =
  | { type: 'session:read'; callId: string }
  | { type: 'session:refresh'; callId: string; apiBaseUrl: string }
  | { type: 'session:clear'; callId: string; includeSidecar: boolean };

export type SyncWorkerCallReply =
  | { type: 'session:read:result'; callId: string; session: SyncSessionView | null }
  | { type: 'session:refresh:result'; callId: string; outcome: SyncRefreshOutcome }
  | { type: 'session:clear:result'; callId: string };

export type SyncWorkerOutbound = SyncWorkerResponse | SyncWorkerCall;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

export function isSyncWorkerResponse(message: unknown): message is SyncWorkerResponse {
  return isRecord(message) && typeof message.type === 'string';
}

export function isSyncWorkerCall(message: unknown): message is SyncWorkerCall {
  return isRecord(message) && typeof message.type === 'string' && String(message.type).startsWith('session:');
}
