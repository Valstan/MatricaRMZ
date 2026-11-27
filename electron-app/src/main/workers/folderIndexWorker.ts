// Процесс индексации дерева папки (промт КАРМАНА #180).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОЦЕСС. Карта дерева — это полный обход папки: на сетевом
// диске это тысячи запросов и десятки секунд. В главном процессе это значит
// зависшее окно и «программа не отвечает». Здесь обход идёт в отдельном
// `utilityProcess`, а главный процесс только слушает прогресс и пишет карту
// на диск.
//
// ОГРАНИЧЕНИЕ СКОРОСТИ — в сборщике карты (`services/folderIndexBuilder.ts`):
// после каждой прочитанной папки пауза, чтобы сеть и диск не выбирались
// целиком, пока оператор работает.
//
// ОГРАНИЧЕНИЯ ПРОЦЕССА. В `utilityProcess` из Electron доступны только `net`
// и `systemPreferences`; `app`, `dialog`, `safeStorage` — нет. Здесь они и не
// нужны: процесс только читает диск и отдаёт карту по порту.

import { buildFolderIndex } from '../services/folderIndexBuilder.js';

import type { FolderIndexWorkerRequest, FolderIndexWorkerResponse } from './folderIndexWorkerProtocol.js';

const port = process.parentPort;
if (!port) {
  throw new Error('folderIndexWorker must be started as a utilityProcess');
}
const parentPort = port;

/** Как часто уходит прогресс (мс). */
const PROGRESS_THROTTLE_MS = 300;

function post(message: FolderIndexWorkerResponse): void {
  try {
    parentPort.postMessage(message);
  } catch {
    // порт закрыт — main нас уже не слушает, процесс всё равно погасят
  }
}

/** Задания, которые главный процесс попросил отменить. */
const cancelledJobs = new Set<string>();

parentPort.on('message', (event: { data?: unknown }) => {
  const message = event?.data as
    | FolderIndexWorkerRequest
    | { type: 'cancel'; jobId: string }
    | { type: 'close' }
    | undefined;
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'cancel') {
    cancelledJobs.add(message.jobId);
    return;
  }
  if (message.type === 'close') {
    post({ type: 'closed' });
    return;
  }
  if (message.type !== 'index') return;

  const req = message;
  let lastProgressAt = 0;
  void buildFolderIndex(
    {
      sourceId: req.sourceId,
      rootPath: req.rootPath,
      maxDepth: req.maxDepth,
      maxFolders: req.maxFolders,
      maxFiles: req.maxFiles,
      rateLimitMs: req.rateLimitMs,
    },
    {
      isCancelled: () => cancelledJobs.has(req.jobId),
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
        lastProgressAt = now;
        post({ type: 'progress', jobId: req.jobId, ...progress });
      },
    },
  )
    .then((index) => {
      if (cancelledJobs.has(req.jobId)) {
        post({ type: 'failed', jobId: req.jobId, error: 'Индексация отменена' });
        return;
      }
      post({ type: 'done', jobId: req.jobId, index });
    })
    .catch((e) => {
      post({ type: 'failed', jobId: req.jobId, error: String(e) });
    });
});

post({ type: 'ready' });
