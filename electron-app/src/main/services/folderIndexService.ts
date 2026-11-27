// Фоновая индексация дерева папки (промт КАРМАНА #180).
//
// ЗАЧЕМ. Поиск по папкам каждый раз обходил диск заново: индекса не было, и
// вторая папка шла «холодной» — обход «ползёл по одной папке». Теперь при
// добавлении папки её дерево индексируется В ФОНЕ, а следующий поиск по этой
// же папке отвечает по карте и диска не трогает.
//
// ОТДЕЛЬНЫЙ ПРОЦЕСС. Обход дерева на сетевом диске — это долго и это сеть.
// В главном процессе окно замирало бы. Поэтому индексация живёт в своём
// `utilityProcess` (как чтение базы и синк), а главный процесс только слушает
// прогресс и пишет готовую карту на диск.
//
// СТОРОЖ. Если индексация не уложилась в разумный срок — процесс останавливается,
// в журнал падает запись «индексирование папки не завершилось», а оператор
// видит предупреждение. Молчания быть не должно: молчащее «фоновое» дело
// выглядит как «программа всё делает», пока она на самом деле висит.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { UtilityProcess } from 'electron';
import { utilityProcess } from 'electron';

import {
  isFolderIndexFresh,
  type FileSearchFolderIndex,
  type FileSearchFolderSource,
  type FolderIndexJobState,
  type FolderIndexProgress,
} from '@matricarmz/shared';

import { MAX_FOLDER_DEPTH, MAX_SCANNED_FOLDERS, MAX_SCANNED_FILES } from './fileSearchFolderService.js';
import {
  isFolderIndexWorkerResponse,
  type FolderIndexWorkerRequest,
  type FolderIndexWorkerResponse,
} from '../workers/folderIndexWorkerProtocol.js';

/** Потолок ожидания одной индексации (мс): не уложилась — процесс останавливаем. */
export const FOLDER_INDEX_TIMEOUT_MS = 15 * 60 * 1000;
/** Пауза между чтениями папок при индексации (мс) — ограничение скорости. */
export const FOLDER_INDEX_RATE_LIMIT_MS = 30;
/** Имя подкаталога машинно-локального хранилища, где лежат карты деревьев. */
export const FOLDER_INDEX_DIR_NAME = 'folder-index';

/** Как идёт индексация папки. */
export type { FolderIndexJobState, FolderIndexProgress };

export type FolderIndexServiceOptions = {
  /** Каталог машинно-локального хранилища, где лежат карты деревьев. */
  storageDir: string;
  /** Журнал клиента (`matricarmz.log`). */
  log: (line: string) => void;
  /** Событие прогресса — уходит в окна. */
  onProgress?: (progress: FolderIndexProgress) => void;
  /**
   * Абсолютный путь к собранному воркеру (`dist/main/folderIndexWorker.js`).
   * Приходит снаружи: `import.meta.url` внутри чанка указывает на
   * `dist/main/chunks/`, а не на `dist/main/`.
   */
  workerPath: string;
  /** Инъекция для тестов: подменить спавн процесса, не поднимая Electron. */
  fork?: (entryPath: string) => UtilityProcess;
  /** Потолок ожидания одной индексации (мс). */
  timeoutMs?: number;
  /** Пауза между чтениями папок (мс). */
  rateLimitMs?: number;
};

type RunningJob = {
  jobId: string;
  source: FileSearchFolderSource;
  timer: NodeJS.Timeout | null;
};

/**
 * Сервис карт деревьев папок.
 *
 * Реализует `FolderIndexLookup` — так его можно подставить прямо в поиск по
 * папкам: поиск спросит свежую карту, а если её нет — попросит построить.
 */
export class FolderIndexService {
  private child: UtilityProcess | null = null;
  private currentJob: RunningJob | null = null;
  private readonly queue: FileSearchFolderSource[] = [];
  private readonly jobs = new Map<string, FolderIndexProgress>();
  /** Разобранные карты — чтобы не читать JSON с диска на каждый поиск. */
  private readonly cache = new Map<string, FileSearchFolderIndex>();
  private readonly timeoutMs: number;
  private readonly rateLimitMs: number;
  private disposed = false;

  constructor(private readonly opts: FolderIndexServiceOptions) {
    this.timeoutMs = opts.timeoutMs ?? FOLDER_INDEX_TIMEOUT_MS;
    this.rateLimitMs = opts.rateLimitMs ?? FOLDER_INDEX_RATE_LIMIT_MS;
  }

  /** Путь файла карты источника. */
  private indexPath(sourceId: string): string {
    return join(this.opts.storageDir, `${sourceId}.json`);
  }

  /**
   * Свежая карта источника — или null.
   *
   * null означает: карты нет, она протухла или папка недоступна. Тогда поиск
   * идёт по диску, а карта строится в фоне.
   */
  async load(source: FileSearchFolderSource): Promise<FileSearchFolderIndex | null> {
    if (this.disposed) return null;
    let index = this.cache.get(source.id);
    if (!index) {
      try {
        const raw = await readFile(this.indexPath(source.id), 'utf8');
        const parsed = JSON.parse(raw) as FileSearchFolderIndex;
        if (!parsed || parsed.sourceId !== source.id || !Array.isArray(parsed.entries)) return null;
        index = parsed;
        this.cache.set(source.id, parsed);
      } catch {
        return null;
      }
    }
    let rootModifiedAt: number | null = null;
    try {
      const st = await stat(source.path);
      rootModifiedAt = st.mtimeMs;
    } catch {
      // Папка недоступна — картой пользоваться нельзя.
      return null;
    }
    if (!isFolderIndexFresh({ index, nowMs: Date.now(), rootModifiedAt })) return null;
    return index;
  }

  /**
   * Поставить папку в очередь на индексацию.
   *
   * Возвращается сразу: оператор не ждёт. Повторный вызов для той же папки,
   * которая уже в работе или в очереди, ничего не делает.
   */
  requestBuild(source: FileSearchFolderSource): void {
    if (this.disposed) return;
    if (!source?.path) return;
    const existing = this.jobs.get(source.id);
    if (existing && (existing.state === 'running' || existing.state === 'idle')) return;
    if (this.queue.some((item) => item.id === source.id)) return;
    this.jobs.set(source.id, {
      sourceId: source.id,
      sourceName: source.name,
      state: 'idle',
      folders: 0,
      files: 0,
      current: null,
      startedAt: null,
      finishedAt: null,
      message: null,
    });
    this.queue.push(source);
    this.pump();
  }

  /** Состояния всех известных индексаций — для окна. */
  list(): FolderIndexProgress[] {
    return [...this.jobs.values()];
  }

  /** Остановить всё: сторож снят, процесс погашен. */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.clearCurrentTimer();
    this.currentJob = null;
    this.killWorker();
  }

  /** Запустить следующее задание из очереди. */
  private pump(): void {
    if (this.disposed) return;
    if (this.currentJob) return;
    const source = this.queue.shift();
    if (!source) return;
    this.startJob(source);
  }

  /** Поднять процесс индексации (один на программу). */
  private ensureWorker(): UtilityProcess | null {
    if (this.child) return this.child;
    try {
      const child = this.opts.fork
        ? this.opts.fork(this.opts.workerPath)
        : utilityProcess.fork(this.opts.workerPath, [], { serviceName: 'matricarmz-folder-index' });
      child.on('message', (message: unknown) => this.handleMessage(message));
      child.on('exit', (code: number) => this.handleExit(code));
      this.child = child;
      return child;
    } catch (e) {
      this.opts.log(`folder-index: процесс индексации не поднялся: ${String(e)}`);
      return null;
    }
  }

  /** Начать индексацию одной папки. */
  private startJob(source: FileSearchFolderSource): void {
    const child = this.ensureWorker();
    if (!child) {
      this.failJob(source, 'Процесс индексации не поднялся');
      return;
    }
    const jobId = randomUUID();
    const startedAt = Date.now();
    this.jobs.set(source.id, {
      sourceId: source.id,
      sourceName: source.name,
      state: 'running',
      folders: 0,
      files: 0,
      current: null,
      startedAt,
      finishedAt: null,
      message: null,
    });
    this.emit(source.id);
    this.currentJob = { jobId, source, timer: null };
    // Сторож: индексация не должна идти бесконечно.
    const timer = setTimeout(() => this.onTimeout(jobId), this.timeoutMs);
    timer.unref?.();
    this.currentJob.timer = timer;

    const request: FolderIndexWorkerRequest = {
      type: 'index',
      jobId,
      sourceId: source.id,
      rootPath: source.path,
      maxDepth: MAX_FOLDER_DEPTH,
      maxFolders: MAX_SCANNED_FOLDERS,
      maxFiles: MAX_SCANNED_FILES,
      rateLimitMs: this.rateLimitMs,
    };
    try {
      child.postMessage(request);
    } catch (e) {
      this.failJob(source, String(e));
    }
  }

  /** Ответы процесса индексации. */
  private handleMessage(message: unknown): void {
    if (!isFolderIndexWorkerResponse(message)) return;
    const current = this.currentJob;
    if (!current) return;
    if (message.type === 'progress') {
      if (message.jobId !== current.jobId) return;
      const job = this.jobs.get(current.source.id);
      if (!job) return;
      this.jobs.set(current.source.id, {
        ...job,
        folders: message.folders,
        files: message.files,
        current: message.current,
      });
      this.emit(current.source.id);
      return;
    }
    if (message.type === 'done') {
      if (message.jobId !== current.jobId) return;
      this.finishJob(current, async () => {
        await this.writeIndex(message.index);
        const job = this.jobs.get(current.source.id);
        this.jobs.set(current.source.id, {
          ...(job ?? this.baseJob(current.source)),
          state: 'done',
          folders: message.index.folderCount,
          files: message.index.fileCount,
          current: null,
          finishedAt: Date.now(),
          message: null,
        });
        this.emit(current.source.id);
      });
      return;
    }
    if (message.type === 'failed') {
      if (message.jobId !== current.jobId) return;
      this.failJob(current.source, message.error);
    }
  }

  /** Процесс индексации умер. */
  private handleExit(code: number): void {
    this.child = null;
    const current = this.currentJob;
    if (!current) return;
    this.failJob(current.source, `Процесс индексации завершился (код ${code})`);
  }

  /** Индексация не уложилась в срок: останавливаем процесс и пишем в журнал. */
  private onTimeout(jobId: string): void {
    const current = this.currentJob;
    if (!current || current.jobId !== jobId) return;
    this.clearCurrentTimer();
    this.currentJob = null;
    const minutes = Math.max(1, Math.round(this.timeoutMs / 60000));
    const message = `Индексирование папки не завершилось за ${minutes} мин — процесс остановлен`;
    // Журнал: молчать нельзя — по записи видно, что фоновое дело зависло.
    this.opts.log(`folder-index: индексирование папки не завершилось — «${current.source.name}» (${minutes} мин), процесс остановлен`);
    const job = this.jobs.get(current.source.id);
    this.jobs.set(current.source.id, {
      ...(job ?? this.baseJob(current.source)),
      state: 'timeout',
      current: null,
      finishedAt: Date.now(),
      message,
    });
    this.emit(current.source.id);
    this.killWorker();
    this.pump();
  }

  /** Задание провалилось — честная запись в журнал и состояние «не удалось». */
  private failJob(source: FileSearchFolderSource, error: string): void {
    if (this.currentJob?.source.id === source.id) {
      this.clearCurrentTimer();
      this.currentJob = null;
    }
    this.opts.log(`folder-index: индексация «${source.name}» не удалась: ${error}`);
    const job = this.jobs.get(source.id);
    this.jobs.set(source.id, {
      ...(job ?? this.baseJob(source)),
      state: 'error',
      current: null,
      finishedAt: Date.now(),
      message: error,
    });
    this.emit(source.id);
    this.pump();
  }

  /** Задание закончилось успешно: снимаем сторож и пишем карту на диск. */
  private finishJob(current: RunningJob, after: () => Promise<void>): void {
    this.clearCurrentTimer();
    this.currentJob = null;
    void after()
      .catch((e) => {
        this.opts.log(`folder-index: карту «${current.source.name}» не сохранили: ${String(e)}`);
      })
      .finally(() => {
        this.pump();
      });
  }

  /** Снять сторож текущего задания. */
  private clearCurrentTimer(): void {
    if (!this.currentJob?.timer) return;
    clearTimeout(this.currentJob.timer);
    this.currentJob.timer = null;
  }

  /** Погасить процесс индексации. */
  private killWorker(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // процесс уже мёртв — ничего делать не надо
    }
  }

  /** Сохранить карту в машинно-локальное хранилище клиента. */
  private async writeIndex(index: FileSearchFolderIndex): Promise<void> {
    await mkdir(this.opts.storageDir, { recursive: true });
    await writeFile(this.indexPath(index.sourceId), JSON.stringify(index), 'utf8');
    this.cache.set(index.sourceId, index);
  }

  /** Заготовка состояния для источника, которого ещё не было в реестре. */
  private baseJob(source: FileSearchFolderSource): FolderIndexProgress {
    return {
      sourceId: source.id,
      sourceName: source.name,
      state: 'idle',
      folders: 0,
      files: 0,
      current: null,
      startedAt: null,
      finishedAt: null,
      message: null,
    };
  }

  /** Отдать состояние подписчикам (окна). */
  private emit(sourceId: string): void {
    const job = this.jobs.get(sourceId);
    if (!job) return;
    this.opts.onProgress?.(job);
  }
}

export type { FolderIndexWorkerResponse };
