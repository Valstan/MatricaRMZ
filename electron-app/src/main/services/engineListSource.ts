// Выбор «кто собирает список двигателей». По умолчанию — отдельный процесс чтения
// (`workers/dataWorker.ts`); сборка в главном остаётся осознанным откатом.
//
// Почему переезд вообще случился (замер 30.10.2026, план
// docs/plans/client-ram-cache-and-sync-worker-2026-10.md, «PR-4, шаг 3»): микрооптимизация
// запросов исчерпана — осталось много фаз по 3–50 мс, а слабая машина умножает каждую
// в 6–8 раз. Блокирует окно не сумма, а сам `better-sqlite3`: он синхронный, и пока
// главный поток собирал список, интерфейс стоял ровно столько же.
//
// Откат один и узкий: `MATRICA_DATA_WORKER=0` — сборка возвращается в главный процесс
// без выпуска нового кода (как `MATRICA_SYNC_WORKER=0` у синка). Второй, автоматический
// откат — на каждом вызове: если воркер не готов или не ответил, список собирается здесь.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { DataProxy } from './dataProxy.js';
import {
  createInProcessEngineListSource,
  type EngineListRead,
  type EngineListSource,
} from './engineListInProcess.js';

export {
  createInProcessEngineListSource,
  type EngineListRead,
  type EngineListSource,
} from './engineListInProcess.js';

export type CreateEngineListSourceArgs = {
  /**
   * Соединение этого процесса. Функция, а не значение: в режиме просмотра копии
   * (`backup`) читается другая база, и откат обязан идти в неё, а не в живую.
   */
  db: () => BetterSQLite3Database;
  dbPath: string;
  dbKey: string | null;
  /** Абсолютный путь к собранному воркеру (`dist/main/dataWorker.js`). */
  workerPath: string;
  userDataPath: () => string;
  log: (line: string) => void;
  /** Инъекция для тестов. */
  fork?: ConstructorParameters<typeof DataProxy>[0]['fork'];
};

export function createEngineListSource(args: CreateEngineListSourceArgs): EngineListSource {
  const inMain = () => createInProcessEngineListSource({ db: args.db });
  const inProcessRead = (): Promise<EngineListRead> => inMain().read();

  const flag = String(process.env.MATRICA_DATA_WORKER ?? '').trim();
  if (flag === '0') {
    args.log('engine list reads in main process: MATRICA_DATA_WORKER=0');
    return inMain();
  }

  let proxy: DataProxy;
  try {
    proxy = new DataProxy({
      dbPath: args.dbPath,
      dbKey: args.dbKey,
      userDataPath: args.userDataPath,
      workerPath: args.workerPath,
      log: args.log,
      ...(args.fork ? { fork: args.fork } : {}),
    });
  } catch (e) {
    args.log(`data worker failed to start, reads stay in main: ${String(e)}`);
    return inMain();
  }

  return {
    outOfProcess: true,
    read: async () => (await proxy.readEngineList()) ?? (await inProcessRead()),
    readHere: inProcessRead,
    warm: () => proxy.warm(),
    dispose: () => proxy.dispose(),
  };
}
