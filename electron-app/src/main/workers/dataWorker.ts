// Процесс чтения данных (`utilityProcess`): собирает список двигателей по просьбе main.
//
// Причина ровно одна — замирания окна. `better-sqlite3` синхронный, и пока главный
// процесс собирал список, интерфейс стоял столько же (на слабых машинах парка 1.8–16 с;
// замер и разбор — в docs/plans/client-ram-cache-and-sync-worker-2026-10.md, раздел
// «PR-4, шаг 3»). Синк уже живёт так же (`workers/syncWorker.ts`), и здесь повторён его
// приём: ключ приходит сообщением, жизнь процесса решает main (`services/dataProxy.ts`).
//
// Что важно знать до правок:
//  * В utility-процессе из Electron есть только `net` и `systemPreferences`; ничего
//    платформенного этому воркеру не нужно — он только читает SQLite.
//  * Соединение своё и **только для чтения** (`PRAGMA query_only = ON`): воркер отдаёт
//    экран, а не правит данные. WAL терпит несколько соединений, `busy_timeout` ставит
//    `openSqlite`.
//  * Кэши сборки (флаги актов, история ремонта) живут здесь, поэтому и прогрев —
//    здесь: главный процесс больше не собирает список и греть ему нечего.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { openSqlite } from '../database/db.js';
import { listEngines, warmEngineListCaches } from '../services/engineService.js';
import { appendLogLine } from '../utils/logger.js';

import type { DataWorkerRequest, DataWorkerResponse } from './dataWorkerProtocol.js';

const port = process.parentPort;
if (!port) {
  throw new Error('dataWorker must be started as a utilityProcess');
}
const parentPort = port;

let db: BetterSQLite3Database | null = null;
let userDataPath = '';
let warming = false;
let warmed = false;

function post(message: DataWorkerResponse): void {
  try {
    parentPort.postMessage(message);
  } catch {
    // порт закрыт — main нас уже не слушает, процесс всё равно погасят
  }
}

function log(message: string): void {
  if (userDataPath) appendLogLine(userDataPath, `data-worker ${message}`);
}

function handleInit(message: Extract<DataWorkerRequest, { type: 'init' }>): void {
  userDataPath = message.userDataPath;
  const opened = openSqlite(message.dbPath, message.dbKey);
  // Чтение, а не запись: даже ошибка в коде не должна получить право менять базу.
  opened.sqlite.pragma('query_only = ON');
  db = opened.db;
  post({ type: 'ready' });
  log(`ready db=${message.dbPath}`);
}

async function warm(): Promise<void> {
  if (!db || warming || warmed) return;
  warming = true;
  const startedAt = Date.now();
  try {
    await warmEngineListCaches(db);
    warmed = true;
    log(`warm ${Date.now() - startedAt}ms`);
  } catch (e) {
    log(`warm failed: ${String(e)}`);
  } finally {
    warming = false;
  }
}

async function handleEngineList(message: Extract<DataWorkerRequest, { type: 'engineList' }>): Promise<void> {
  if (!db) {
    post({ type: 'engineList:failed', reqId: message.reqId, error: 'data worker not ready' });
    return;
  }
  const phases: Record<string, number> = {};
  const startedAt = Date.now();
  try {
    const rows = await listEngines(db, {
      onPhase: (phase, ms) => {
        phases[phase] = Math.round(ms);
      },
    });
    post({ type: 'engineList:result', reqId: message.reqId, rows, phases, ms: Date.now() - startedAt });
  } catch (e) {
    log(`engine:list failed: ${String(e)}`);
    post({ type: 'engineList:failed', reqId: message.reqId, error: String(e) });
  }
}

function handleMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as DataWorkerRequest;
  switch (message.type) {
    case 'init':
      try {
        handleInit(message);
      } catch (e) {
        log(`init failed: ${String(e)}`);
        post({ type: 'fatal', error: String(e) });
      }
      return;
    case 'warm':
      void warm();
      return;
    case 'engineList':
      void handleEngineList(message);
      return;
    case 'close':
      db = null;
      post({ type: 'closed' });
      log('closed by main');
      return;
    default:
      return;
  }
}

// Порт асимметричен: в воркере сообщение приходит обёрткой `MessageEvent` с `.data`
// (в main — голым сообщением). Одна общая «на всякий случай» форма ломает канал молча.
parentPort.on('message', (event: { data: unknown }) => handleMessage(event.data));

process.on('uncaughtException', (e) => {
  log(`uncaught: ${String(e?.stack ?? e)}`);
  post({ type: 'fatal', error: String(e) });
});
process.on('unhandledRejection', (e) => {
  log(`unhandled rejection: ${String(e)}`);
});
