// Движок синка в отдельном процессе (`utilityProcess`). Причина переезда — не
// экономия памяти, а замирания окна: `better-sqlite3` синхронный, и пока главный поток
// применял pull, интерфейс стоял (см. docs/plans/client-ram-cache-and-sync-worker-2026-10.md).
//
// Что здесь важно знать до правок:
//  * В utility-процессе из Electron доступны только `net` и `systemPreferences`.
//    `app`, `safeStorage`, `dialog` — нет вовсе. Поэтому всё платформенное приходит
//    через `syncHost`, а сессия — запросом в main по порту (`syncSession`).
//  * Соединение SQLite у воркера своё: две WAL-читалки/писателя на один файл — штатный
//    режим, а `busy_timeout` ставится в `openSqlite`.
//  * Воркер ничего не решает про свою жизнь: перезапуск, откат на in-process движок и
//    флаг `MATRICA_SYNC_WORKER=0` живут в `services/syncProxy.ts`.
import { randomUUID } from 'node:crypto';

import type { SyncProgressEvent } from '@matricarmz/shared';

import { openSqlite } from '../database/db.js';
import { readEventLoopLag, startEventLoopLagMonitor } from '../services/eventLoopLag.js';
import { setSyncHost } from '../services/syncHost.js';
import { SyncManager } from '../services/syncManager.js';
import { setSyncSessionProvider } from '../services/syncSession.js';
import type { RunSyncOptions } from '../services/syncService.js';
import { appendLogLine } from '../utils/logger.js';

import type {
  SyncWorkerCall,
  SyncWorkerCallReply,
  SyncWorkerOutbound,
  SyncWorkerRequest,
  SyncWireRunOpts,
  SyncWireStatus,
} from './syncWorkerProtocol.js';

const port = process.parentPort;
if (!port) {
  throw new Error('syncWorker must be started as a utilityProcess');
}
const parentPort = port;

let manager: SyncManager | null = null;
let userDataPath = '';
let appVersion = '';
let lastStatusJson = '';
let statusTimer: NodeJS.Timeout | null = null;

const pendingCalls = new Map<string, (reply: SyncWorkerCallReply | null) => void>();
/** Дольше этого main не может не ответить: порт внутри процесса, а не сеть. */
const MAIN_CALL_TIMEOUT_MS = 10_000;

function post(message: SyncWorkerOutbound): void {
  try {
    parentPort.postMessage(message);
  } catch {
    // порт закрыт — main нас уже не слушает, процесс всё равно погасят
  }
}

function log(message: string): void {
  if (userDataPath) appendLogLine(userDataPath, `sync-worker ${message}`);
}

/** Запрос в main: только там есть `safeStorage`, которым расшифровывается сессия. */
function callMain(request: SyncWorkerCall): Promise<SyncWorkerCallReply | null> {
  const callId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingCalls.delete(callId)) resolve(null);
    }, MAIN_CALL_TIMEOUT_MS);
    timer.unref?.();
    pendingCalls.set(callId, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    post({ ...request, callId } as SyncWorkerCall);
  });
}

setSyncSessionProvider({
  read: async () => {
    const reply = await callMain({ type: 'session:read', callId: '' });
    if (reply?.type !== 'session:read:result') {
      // Молчание моста не имеет права выглядеть как «пользователь не вошёл»: движок
      // в этом случае объявит `auth required` и завершит прогон без единой строки в
      // логе, а снаружи это «синк перестал ходить и ничего не сказал».
      log('session read: no answer from main');
      return null;
    }
    return reply.session;
  },
  refresh: async (_db, args) => {
    const reply = await callMain({ type: 'session:refresh', callId: '', apiBaseUrl: args.apiBaseUrl });
    return reply?.type === 'session:refresh:result'
      ? reply.outcome
      : { ok: false, error: 'no answer from main' };
  },
  clear: async (_db, opts) => {
    await callMain({ type: 'session:clear', callId: '', includeSidecar: opts?.includeSidecar !== false });
  },
});

function handleCallReply(reply: SyncWorkerCallReply): void {
  const resolver = pendingCalls.get(reply.callId);
  if (!resolver) return;
  pendingCalls.delete(reply.callId);
  resolver(reply);
}

function emitProgress(event: SyncProgressEvent): void {
  post({ type: 'progress', payload: event });
}

function toRunOptions(opts: SyncWireRunOpts): RunSyncOptions {
  if (opts.fullPull) {
    return { fullPull: { ...opts.fullPull, onProgress: emitProgress } };
  }
  return {
    progress: {
      mode: 'incremental',
      ...(opts.startedAt != null ? { startedAt: opts.startedAt } : {}),
      onProgress: emitProgress,
    },
  };
}

function snapshotStatus(): SyncWireStatus | null {
  if (!manager) return null;
  const status = manager.getStatus();
  return {
    state: status.state,
    lastSyncAt: status.lastSyncAt,
    lastError: status.lastError,
    lastResult: status.lastResult,
    nextAutoSyncAt: manager.getNextAutoSyncAt(),
    apiBaseUrl: manager.getApiBaseUrl(),
  };
}

function pushStatus(force = false): void {
  const status = snapshotStatus();
  if (!status) return;
  const json = JSON.stringify(status);
  if (!force && json === lastStatusJson) return;
  lastStatusJson = json;
  post({ type: 'status', status });
}

/**
 * Статус опрашиваем раз в секунду и отправляем только при изменении. Альтернатива —
 * прокинуть событие из `SyncManager` — потребовала бы от движка знать про транспорт,
 * а автозапуски (пробуждение сервером, сторож своих правок) стартуют внутри него.
 */
function startStatusLoop(): void {
  if (statusTimer) return;
  statusTimer = setInterval(() => pushStatus(), 1_000);
  statusTimer.unref?.();
}

function handleInit(message: Extract<SyncWorkerRequest, { type: 'init' }>): void {
  userDataPath = message.userDataPath;
  appVersion = message.appVersion;
  setSyncHost({
    userDataPath: () => userDataPath,
    appVersion: () => appVersion,
    // Пересоздание локальной базы в воркере не выполняется: main отпускает его
    // соединение и делает сброс сам.
    relaunch: () => {},
    exit: () => {},
    appendLog: log,
  });
  startEventLoopLagMonitor();
  const opened = openSqlite(message.dbPath, message.dbKey);
  manager = new SyncManager(opened.db, message.clientId, message.apiBaseUrl, {
    onProgress: emitProgress,
    readLag: readEventLoopLag,
  });
  if (message.autoSyncMs && message.autoSyncMs > 0) manager.startAuto(message.autoSyncMs);
  startStatusLoop();
  post({ type: 'ready' });
  pushStatus(true);
  log(`ready db=${message.dbPath} auto=${message.autoSyncMs ?? 'off'}`);
}

async function handleRun(message: Extract<SyncWorkerRequest, { type: 'run' }>): Promise<void> {
  if (!manager) {
    post({ type: 'runFailed', reqId: message.reqId, error: 'sync worker not ready' });
    return;
  }
  try {
    const result = await manager.runOnce(toRunOptions(message.opts));
    post({ type: 'runResult', reqId: message.reqId, result });
    pushStatus();
  } catch (e) {
    post({ type: 'runFailed', reqId: message.reqId, error: String(e) });
    pushStatus();
  }
}

function handleMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as SyncWorkerRequest | SyncWorkerCallReply;
  switch (message.type) {
    case 'init':
      try {
        handleInit(message);
      } catch (e) {
        log(`init failed: ${String(e)}`);
        post({ type: 'fatal', error: String(e) });
      }
      return;
    case 'run':
      void handleRun(message);
      return;
    case 'setApiBaseUrl':
      manager?.setApiBaseUrl(message.apiBaseUrl);
      pushStatus();
      return;
    case 'startAuto':
      manager?.startAuto(message.intervalMs);
      pushStatus(true);
      return;
    case 'stopAuto':
      manager?.stopAuto();
      pushStatus(true);
      return;
    case 'close':
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      manager?.stopAuto();
      manager = null;
      post({ type: 'closed' });
      log('closed by main');
      return;
    case 'session:read:result':
    case 'session:refresh:result':
    case 'session:clear:result':
      handleCallReply(message);
      return;
    default:
      return;
  }
}

parentPort.on('message', (event: { data: unknown }) => handleMessage(event.data));

process.on('uncaughtException', (e) => {
  log(`uncaught: ${String(e?.stack ?? e)}`);
  post({ type: 'fatal', error: String(e) });
});
process.on('unhandledRejection', (e) => {
  log(`unhandled rejection: ${String(e)}`);
});
