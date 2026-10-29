// Движок синка в отдельном процессе: пульт, супервизор и кэш статуса.
//
// Зачем прокси, а не прямое использование `utilityProcess` в `registerIpc`: вызывающих
// больше сорока, и им нужен тот же API, что у `SyncManager`, включая синхронные
// `getStatus()`/`getApiBaseUrl()`. Поэтому статус и адрес сервера кэшируются здесь,
// а всё, что делает работу, уезжает сообщением.
//
// Жизненный цикл: процесс поднимается сам при первом обращении, падает — поднимается
// снова с backoff 1→30 с. Откат на in-process движок — переменной окружения
// `MATRICA_SYNC_WORKER=0` (и автоматически при включённом E2E, см. фабрику).
import { randomUUID } from 'node:crypto';

import type { UtilityProcess } from 'electron';
import { utilityProcess } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SyncRunResult, SyncStatus } from '@matricarmz/shared';

import {
  isSyncWorkerCall,
  isSyncWorkerResponse,
  type SyncWorkerCallReply,
  type SyncWorkerInit,
  type SyncWorkerResponse,
  type SyncWireRunOpts,
  type SyncWireStatus,
} from '../workers/syncWorkerProtocol.js';
import type { SyncControl } from './syncControl.js';
import { getSyncHost } from './syncHost.js';
import { clearSyncSession, readSyncSession, refreshSyncSession } from './syncSession.js';
import type { RunSyncOptions } from './syncService.js';

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;
/** Готовность = открыть базу и собрать движок; на большой базе это ANALYZE. */
const READY_TIMEOUT_MS = 60_000;
/** Закрытие по просьбе main (перед пересозданием базы) — быстрее любого таймаута. */
const CLOSE_TIMEOUT_MS = 5_000;
/** Страховка от вечно висящего прогона: сеть внутри воркера ограничена своими таймаутами. */
const RUN_TIMEOUT_MS = 30 * 60_000;

export type SyncProxyOptions = {
  db: BetterSQLite3Database;
  clientId: string;
  apiBaseUrl: string;
  dbPath: string;
  dbKey: string | null;
  /** Интервал страховочного тика; null — автосинк не запускать. */
  autoSyncMs: number | null;
  onProgress: (payload: unknown) => void;
  log: (line: string) => void;
  /**
   * Абсолютный путь к собранному воркеру. Приходит снаружи, потому что `import.meta.url`
   * внутри чанка указывает на `dist/main/chunks/`, а не на `dist/main/`.
   */
  workerPath: string;
  /** Инъекция для тестов: подменить спавн процесса, не поднимая Electron. */
  fork?: (entryPath: string) => UtilityProcess;
};

type PendingRun = {
  resolve: (result: SyncRunResult) => void;
  timer: NodeJS.Timeout;
};

type ReadyWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function failedRun(error: string): SyncRunResult {
  return { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error };
}

/** Колбэки прогресса через порт не ходят — воркер сам шлёт их в main. */
function toWireRunOpts(opts?: RunSyncOptions): SyncWireRunOpts {
  if (opts?.fullPull) {
    return {
      mode: 'force_full_pull',
      startedAt: opts.fullPull.startedAt,
      fullPull: {
        reason: opts.fullPull.reason,
        startedAt: opts.fullPull.startedAt,
        estimateMs: opts.fullPull.estimateMs,
      },
    };
  }
  return {
    mode: 'incremental',
    ...(opts?.progress?.startedAt != null ? { startedAt: opts.progress.startedAt } : {}),
  };
}

export class SyncProxy implements SyncControl {
  private child: UtilityProcess | null = null;
  private ready = false;
  /** Намеренное закрытие: перезапуск не планируется до явного `startAuto`. */
  private closing = false;
  private disposed = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private autoSyncMs: number | null;
  private apiBaseUrl: string;
  private status: SyncWireStatus;
  private readonly runs = new Map<string, PendingRun>();
  private readonly readyWaiters: ReadyWaiter[] = [];
  /** Ожидающий закрытия по просьбе main (см. `releaseDatabase`). */
  private onClose: (() => void) | null = null;

  constructor(private readonly opts: SyncProxyOptions) {
    this.apiBaseUrl = opts.apiBaseUrl;
    this.autoSyncMs = opts.autoSyncMs;
    this.status = {
      state: 'idle',
      lastSyncAt: null,
      lastError: null,
      lastResult: null,
      nextAutoSyncAt: null,
      apiBaseUrl: opts.apiBaseUrl,
    };
    this.spawn();
  }

  // ── SyncControl ──────────────────────────────────────────────────────────

  getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  setApiBaseUrl(next: string): void {
    this.apiBaseUrl = next;
    this.status.apiBaseUrl = next;
    this.child?.postMessage({ type: 'setApiBaseUrl', apiBaseUrl: next });
  }

  getStatus(): SyncStatus {
    const nextAutoSyncInMs =
      this.status.nextAutoSyncAt == null ? null : Math.max(0, this.status.nextAutoSyncAt - Date.now());
    const crashed = !this.ready && !this.closing && this.restartAttempts > 0;
    return {
      state: crashed ? 'error' : this.status.state,
      lastSyncAt: this.status.lastSyncAt,
      lastError: crashed ? 'движок синхронизации перезапускается' : this.status.lastError,
      lastResult: this.status.lastResult,
      nextAutoSyncInMs,
    };
  }

  async runOnce(opts?: RunSyncOptions): Promise<SyncRunResult> {
    const wire = toWireRunOpts(opts);
    try {
      await this.waitForReady();
    } catch (e) {
      return failedRun(String(e));
    }
    const child = this.child;
    if (!child) return failedRun('sync worker is not running');
    const reqId = randomUUID();
    return await new Promise<SyncRunResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.runs.delete(reqId)) return;
        this.opts.log(`sync worker run timed out after ${RUN_TIMEOUT_MS}ms`);
        resolve(failedRun('sync worker timeout'));
      }, RUN_TIMEOUT_MS);
      timer.unref?.();
      this.runs.set(reqId, { resolve, timer });
      child.postMessage({ type: 'run', reqId, opts: wire });
    });
  }

  startAuto(intervalMs: number): void {
    this.autoSyncMs = intervalMs;
    this.closing = false;
    this.ensureStarted();
    this.child?.postMessage({ type: 'startAuto', intervalMs });
  }

  stopAuto(): void {
    this.autoSyncMs = null;
    this.child?.postMessage({ type: 'stopAuto' });
  }

  /**
   * Отпустить файл базы перед пересозданием: воркер закрывает своё соединение и не
   * поднимается, пока не позовут `startAuto` (после сброса приложение перезапускается).
   */
  async releaseDatabase(): Promise<void> {
    this.closing = true;
    this.autoSyncMs = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.ready = false;
    this.failPendingRuns('sync engine released local database');
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onClose = null;
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // уже мёртв
        }
        finish();
      }, CLOSE_TIMEOUT_MS);
      timer.unref?.();
      this.onClose = finish;
      child.postMessage({ type: 'close' });
    });
  }

  /** Остановить навсегда (выход приложения): без перезапусков и без ожидания. */
  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.failPendingRuns('app is quitting');
    try {
      child?.kill();
    } catch {
      // уже мёртв
    }
  }

  // ── процесс ──────────────────────────────────────────────────────────────

  private ensureStarted(): void {
    if (this.child || this.disposed || this.closing) return;
    this.spawn();
  }

  private spawn(): void {
    if (this.child || this.disposed) return;
    const entry = this.opts.workerPath;
    let child: UtilityProcess;
    try {
      child = this.opts.fork
        ? this.opts.fork(entry)
        : utilityProcess.fork(entry, [], { serviceName: 'matricarmz-sync' });
    } catch (e) {
      this.opts.log(`sync worker spawn failed: ${String(e)}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.ready = false;
    child.on('message', (event: { data: unknown }) => this.handleMessage(event.data));
    child.on('exit', (code: number) => this.handleExit(code));

    const init: SyncWorkerInit = {
      type: 'init',
      dbPath: this.opts.dbPath,
      userDataPath: getSyncHost().userDataPath(),
      appVersion: getSyncHost().appVersion(),
      dbKey: this.opts.dbKey,
      clientId: this.opts.clientId,
      apiBaseUrl: this.apiBaseUrl,
      autoSyncMs: this.autoSyncMs,
    };
    child.postMessage(init);
  }

  private handleMessage(raw: unknown): void {
    if (isSyncWorkerCall(raw)) {
      void this.handleCall(raw);
      return;
    }
    if (!isSyncWorkerResponse(raw)) return;
    this.handleResponse(raw);
  }

  private handleResponse(message: SyncWorkerResponse): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.restartAttempts = 0;
        for (const waiter of this.readyWaiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
        this.opts.log('sync worker ready');
        return;
      case 'status':
        this.status = message.status;
        this.apiBaseUrl = message.status.apiBaseUrl;
        return;
      case 'progress':
        this.opts.onProgress(message.payload);
        return;
      case 'runResult':
      case 'runFailed': {
        const pending = this.runs.get(message.reqId);
        if (!pending) return;
        this.runs.delete(message.reqId);
        clearTimeout(pending.timer);
        pending.resolve(message.type === 'runResult' ? message.result : failedRun(message.error));
        return;
      }
      case 'fatal':
        this.opts.log(`sync worker fatal: ${message.error}`);
        return;
      case 'closed':
        this.opts.log('sync worker closed its database');
        this.settleClose();
        return;
      default:
        return;
    }
  }

  private async handleCall(call: { type: string; callId: string; apiBaseUrl?: string; includeSidecar?: boolean }): Promise<void> {
    let reply: SyncWorkerCallReply;
    if (call.type === 'session:read') {
      const session = await readSyncSession(this.opts.db);
      reply = { type: 'session:read:result', callId: call.callId, session };
    } else if (call.type === 'session:refresh') {
      const outcome = await refreshSyncSession(this.opts.db, { apiBaseUrl: call.apiBaseUrl ?? this.apiBaseUrl });
      reply = { type: 'session:refresh:result', callId: call.callId, outcome };
    } else {
      await clearSyncSession(this.opts.db, { includeSidecar: call.includeSidecar !== false });
      reply = { type: 'session:clear:result', callId: call.callId };
    }
    this.child?.postMessage(reply);
  }

  private handleExit(code: number): void {
    const wasReady = this.ready;
    this.child = null;
    this.ready = false;
    this.failPendingRuns('sync worker exited');
    for (const waiter of this.readyWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('sync worker exited'));
    }
    if (this.closing || this.disposed) {
      this.settleClose();
      return;
    }
    this.opts.log(`sync worker exited code=${code}${wasReady ? '' : ' (before ready)'}`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.closing || this.disposed) return;
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.min(this.restartAttempts, 5));
    this.restartAttempts += 1;
    this.opts.log(`sync worker restart in ${delay}ms (attempt ${this.restartAttempts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  private failPendingRuns(error: string): void {
    for (const [reqId, pending] of this.runs) {
      this.runs.delete(reqId);
      clearTimeout(pending.timer);
      pending.resolve(failedRun(error));
    }
  }

  private waitForReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.disposed) return Promise.reject(new Error('sync worker is disposed'));
    if (this.closing) return Promise.reject(new Error('sync worker released its database'));
    this.ensureStarted();
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.readyWaiters.indexOf(waiter);
          if (index >= 0) this.readyWaiters.splice(index, 1);
          reject(new Error('sync worker is not ready'));
        }, READY_TIMEOUT_MS),
      };
      waiter.timer.unref?.();
      this.readyWaiters.push(waiter);
    });
  }

  private settleClose(): void {
    const done = this.onClose;
    this.onClose = null;
    done?.();
  }
}
