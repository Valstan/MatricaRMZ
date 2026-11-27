// Протокол между главным процессом и процессом индексации папок
// (промт КАРМАНА #180).
//
// Индексация идёт отдельным процессом (`utilityProcess`): построение карты
// дерева — это полный обход папки на сетевом диске, а главный процесс не
// должен замирать и выбирать сеть целиком.
//
// Модуль без node/electron-импортов: его тянут оба процесса и тесты прокси.

import type { FileSearchFolderIndex } from '@matricarmz/shared';

/** Имя входного файла воркера в `dist/main` (см. `electron.vite.config.ts`). */
export const FOLDER_INDEX_WORKER_ENTRY = 'folderIndexWorker.js';

/** Заявка главного процесса: построить карту дерева папки. */
export type FolderIndexWorkerRequest = {
  type: 'index';
  jobId: string;
  /** id источника-папки, к которому относится карта. */
  sourceId: string;
  /** Корень обхода. */
  rootPath: string;
  /** Потолок глубины вложенности. */
  maxDepth: number;
  /** Потолок числа папок. */
  maxFolders: number;
  /** Потолок числа файлов. */
  maxFiles: number;
  /** Пауза между чтениями папок (мс) — ограничение скорости. */
  rateLimitMs: number;
};

/** Ответы процесса индексации главному процессу. */
export type FolderIndexWorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; jobId: string; folders: number; files: number; current: string | null }
  | { type: 'done'; jobId: string; index: FileSearchFolderIndex }
  | { type: 'failed'; jobId: string; error: string }
  | { type: 'closed' };

export function isFolderIndexWorkerResponse(message: unknown): message is FolderIndexWorkerResponse {
  return Boolean(message) && typeof message === 'object' && typeof (message as { type?: unknown }).type === 'string';
}
