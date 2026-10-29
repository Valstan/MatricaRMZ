// Выбор «где живёт движок синка». По умолчанию — отдельный процесс; в главном он
// остаётся как осознанный откат.
//
// Откатов два и оба узкие:
//  * `MATRICA_SYNC_WORKER=0` — ручной, на случай беды в поле (переменную видно в
//    диагностике, приложение поднимается как до PR-2);
//  * включённое E2E (`MATRICA_LEDGER_E2E=1`) — автоматический. Ключ шифрования строк
//    читается через `safeStorage`, которого в utility-процессе нет; отдать воркеру
//    копию кольца значило бы разойтись с ротацией ключей и писать строки ключом,
//    который соседние клиенты уже не поймут. На проде E2E выключен, так что это
//    страховка, а не повседневный путь.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { EventLoopLag } from './eventLoopLagMetrics.js';
import type { SyncControl } from './syncControl.js';
import { isE2eEnabled } from './sync/e2eCrypto.js';
import { SyncManager } from './syncManager.js';
import { SyncProxy } from './syncProxy.js';

export type CreateSyncControlArgs = {
  db: BetterSQLite3Database;
  clientId: string;
  apiBaseUrl: string;
  dbPath: string;
  dbKey: string | null;
  /** Интервал страховочного тика (основную доставку держат пробуждение и сторож). */
  autoSyncMs: number;
  /** Абсолютный путь к собранному воркеру (`dist/main/syncWorker.js`). */
  workerPath: string;
  onProgress: (payload: unknown) => void;
  readLag: () => EventLoopLag | null;
  log: (line: string) => void;
};

export function createSyncControl(args: CreateSyncControlArgs): SyncControl {
  const inProcess = (why: string): SyncControl => {
    args.log(`sync engine in main process: ${why}`);
    return new SyncManager(args.db, args.clientId, args.apiBaseUrl, {
      onProgress: args.onProgress,
      readLag: args.readLag,
    });
  };

  const flag = String(process.env.MATRICA_SYNC_WORKER ?? '').trim();
  if (flag === '0') return inProcess('MATRICA_SYNC_WORKER=0');
  if (isE2eEnabled()) return inProcess('E2E row keys live in the main process only');

  try {
    return new SyncProxy({
      db: args.db,
      clientId: args.clientId,
      apiBaseUrl: args.apiBaseUrl,
      dbPath: args.dbPath,
      dbKey: args.dbKey,
      autoSyncMs: args.autoSyncMs,
      onProgress: args.onProgress,
      log: args.log,
      workerPath: args.workerPath,
    });
  } catch (e) {
    args.log(`sync worker failed to start, staying in main: ${String(e)}`);
    return inProcess('worker spawn failed');
  }
}
