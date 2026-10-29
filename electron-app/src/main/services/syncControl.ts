// Пульт движка синка — то, чем пользуются IPC-хендлеры и фоновые сервисы. Одна и та же
// форма у двух реализаций: `SyncManager` (движок здесь же, в главном процессе) и
// `SyncProxy` (движок в отдельном процессе). Вызывающим всё равно, где он живёт, —
// поэтому переезд движка не потащил за собой правки в сорока местах.
//
// `getApiBaseUrl` и `getStatus` намеренно синхронные: их зовут из ~40 хендлеров на
// каждый запрос UI, и превращать их в await значило бы править весь IPC-слой.
import type { SyncRunResult, SyncStatus } from '@matricarmz/shared';

import type { RunSyncOptions } from './syncService.js';

/**
 * Страховочный тик. Основную доставку держат пробуждение сервером и сторож своих
 * правок (оба внутри движка); интервал остаётся на случай, когда подвели они —
 * оборвалась сессия, сервер старее клиента, сеть отвечает молчанием.
 */
export const AUTO_SYNC_MS = 60_000;

export type SyncControl = {
  getApiBaseUrl: () => string;
  setApiBaseUrl: (next: string) => void;
  getStatus: () => SyncStatus;
  runOnce: (opts?: RunSyncOptions) => Promise<SyncRunResult>;
  startAuto: (intervalMs: number) => void;
  stopAuto: () => void;
  /**
   * Отпустить файл локальной базы перед её пересозданием. Воркер закрывает своё
   * соединение и не поднимается заново, пока не позовут `startAuto`; движок в этом же
   * процессе ничего не отпускает — файл закроет сам `resetLocalDatabase`.
   */
  releaseDatabase: () => Promise<void>;
  /** Остановить движок насовсем (выход приложения). */
  dispose: () => void;
};
