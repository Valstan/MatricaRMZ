// Пульт процесса чтения данных: поднять, дождаться готовности, позвать, перезапустить.
//
// Зачем прокси, а не прямой `utilityProcess` в IPC: у читателя списка должна быть одна
// точка отказа и один откат. Главное правило здесь — **никогда не заставлять оператора
// ждать воркер**: если процесс ещё поднимается или уже признан негодным, вызов сразу
// возвращает `null`, а вызывающий собирает список в своём процессе (медленнее, но
// работает). Поэтому переезд чтений не может «сломать список» — он может только не
// ускорить.
//
// Жизненный цикл: процесс поднимается лениво (первый `warm()`/вызов), падает —
// поднимается с backoff 1→30 с; после `MAX_ATTEMPTS` неудач на сессию признаётся
// негодным и больше не мешает. Ручной откат — `MATRICA_DATA_WORKER=0` (см. фабрику).
import { randomUUID } from 'node:crypto';

import type { UtilityProcess } from 'electron';
import { utilityProcess } from 'electron';
import type { EngineListItem } from '@matricarmz/shared';

import {
  isDataWorkerResponse,
  type DataWorkerInit,
  type DataWorkerResponse,
} from '../workers/dataWorkerProtocol.js';

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;
/** После стольких неудачных подъёмов воркер считается негодным до перезапуска приложения. */
const MAX_ATTEMPTS = 5;
/** Открытие базы и `optimize` на большой базе — секунды; минута с запасом. */
const READY_TIMEOUT_MS = 60_000;
/**
 * Терпение одного вызова. Худшее живое наблюдение — 16 с (слабая машина, холодный
 * диск); ждать дольше нельзя: лучше медленный путь в своём процессе, чем вечный спиннер.
 */
const CALL_TIMEOUT_MS = 20_000;

export type EngineListReadResult = {
  rows: EngineListItem[];
  phases: Record<string, number>;
  ms: number;
};

export type DataProxyOptions = {
  dbPath: string;
  dbKey: string | null;
  userDataPath: () => string;
  workerPath: string;
  log: (line: string) => void;
  /** Инъекция для тестов: подменить спавн процесса, не поднимая Electron. */
  fork?: (entryPath: string) => UtilityProcess;
};

type PendingCall = {
  resolve: (result: EngineListReadResult | null) => void;
  timer: NodeJS.Timeout;
};

export class DataProxy {
  private child: UtilityProcess | null = null;
  private ready = false;
  private disposed = false;
  private attempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private readonly calls = new Map<string, PendingCall>();
  /** `warm` пришёл раньше готовности — отправим, как только процесс ответит `ready`. */
  private warmOnReady = false;

  constructor(private readonly opts: DataProxyOptions) {}

  /** Готов ли процесс отвечать. Ложь — вызывающий собирает список сам. */
  get isReady(): boolean {
    return this.ready;
  }

  warm(): void {
    if (this.disposed) return;
    if (!this.child) {
      this.spawn();
      this.warmOnReady = true;
      return;
    }
    if (this.ready) {
      this.child.postMessage({ type: 'warm' });
      return;
    }
    this.warmOnReady = true;
  }

  /**
   * Список двигателей из отдельного процесса. `null` — воркер не может (ещё поднимается,
   * отказал, не ответил вовремя): решение, чем заменить, принимает вызывающий.
   */
  async readEngineList(): Promise<EngineListReadResult | null> {
    if (this.disposed) return null;
    if (!this.child) this.spawn();
    const child = this.child;
    if (!this.ready || !child) return null;
    const reqId = randomUUID();
    return await new Promise<EngineListReadResult | null>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.calls.delete(reqId)) return;
        this.opts.log(`data worker engine:list timed out after ${CALL_TIMEOUT_MS}ms`);
        this.dropChild('engine:list timeout');
        resolve(null);
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.calls.set(reqId, { resolve, timer });
      child.postMessage({ type: 'engineList', reqId });
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.clearReadyTimer();
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.failPending('data worker disposed');
    try {
      child?.kill();
    } catch {
      // уже мёртв
    }
  }

  // ── процесс ──────────────────────────────────────────────────────────────

  private spawn(): void {
    if (this.child || this.disposed) return;
    const entry = this.opts.workerPath;
    let child: UtilityProcess;
    try {
      child = this.opts.fork
        ? this.opts.fork(entry)
        : utilityProcess.fork(entry, [], { serviceName: 'matricarmz-data' });
    } catch (e) {
      this.opts.log(`data worker spawn failed: ${String(e)}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.ready = false;
    // Здесь (UtilityProcess) обработчик получает само сообщение; в воркере
    // (`process.parentPort`) — обёртку `MessageEvent` с `.data` (см. M181).
    child.on('message', (message: unknown) => this.handleMessage(message));
    child.on('exit', (code: number) => this.handleExit(code));

    this.readyTimer = setTimeout(() => {
      this.opts.log(`data worker not ready in ${READY_TIMEOUT_MS}ms, dropping`);
      this.dropChild('ready timeout');
    }, READY_TIMEOUT_MS);
    this.readyTimer.unref?.();

    const init: DataWorkerInit = {
      type: 'init',
      dbPath: this.opts.dbPath,
      dbKey: this.opts.dbKey,
      userDataPath: this.opts.userDataPath(),
    };
    child.postMessage(init);
  }

  private handleMessage(raw: unknown): void {
    if (!isDataWorkerResponse(raw)) return;
    this.handleResponse(raw);
  }

  private handleResponse(message: DataWorkerResponse): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.attempts = 0;
        this.clearReadyTimer();
        this.opts.log('data worker ready');
        if (this.warmOnReady) {
          this.warmOnReady = false;
          this.child?.postMessage({ type: 'warm' });
        }
        return;
      case 'engineList:result': {
        const pending = this.calls.get(message.reqId);
        if (!pending) return;
        this.calls.delete(message.reqId);
        clearTimeout(pending.timer);
        pending.resolve({ rows: message.rows, phases: message.phases, ms: message.ms });
        return;
      }
      case 'engineList:failed': {
        const pending = this.calls.get(message.reqId);
        this.opts.log(`data worker engine:list failed: ${message.error}`);
        if (!pending) return;
        this.calls.delete(message.reqId);
        clearTimeout(pending.timer);
        pending.resolve(null);
        return;
      }
      case 'fatal':
        this.opts.log(`data worker fatal: ${message.error}`);
        return;
      case 'closed':
        this.opts.log('data worker closed its database');
        return;
      default:
        return;
    }
  }

  private handleExit(code: number): void {
    const wasReady = this.ready;
    this.child = null;
    this.ready = false;
    this.clearReadyTimer();
    this.failPending('data worker exited');
    if (this.disposed) return;
    this.opts.log(`data worker exited code=${code}${wasReady ? '' : ' (before ready)'}`);
    this.scheduleRestart();
  }

  /** Убрать процесс и не ждать его: вызовы текущего запроса уходят на медленный путь. */
  private dropChild(why: string): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.clearReadyTimer();
    this.failPending(why);
    try {
      child?.kill();
    } catch {
      // уже мёртв
    }
    if (!this.disposed) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.disposed) return;
    if (this.attempts >= MAX_ATTEMPTS) {
      this.opts.log(`data worker gave up after ${this.attempts} attempts, reads stay in main`);
      return;
    }
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.min(this.attempts, 5));
    this.attempts += 1;
    this.opts.log(`data worker restart in ${delay}ms (attempt ${this.attempts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  private failPending(why: string): void {
    if (this.calls.size > 0) this.opts.log(`data worker dropped ${this.calls.size} call(s): ${why}`);
    for (const [reqId, pending] of this.calls) {
      this.calls.delete(reqId);
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }
}
