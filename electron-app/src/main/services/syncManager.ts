import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SyncRunResult, SyncStatus } from '@matricarmz/shared';

import { flushPendingEngineReservationReleases } from './engineReservationClient.js';
import { runSync } from './syncService.js';
import { isOfflineSyncError } from './sync/syncErrorClassifier.js';
import { computeNextSyncDelayMs } from './sync/syncScheduling.js';
import { SettingsKey, settingsGetString } from './settingsStore.js';

type RunSyncOpts = Parameters<typeof runSync>[3];
type ProgressHandler = NonNullable<NonNullable<RunSyncOpts>['progress']>['onProgress'];

function nowMs() {
  return Date.now();
}

export class SyncManager {
  private state: SyncStatus['state'] = 'idle';
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;
  private lastResult: SyncRunResult | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextAt: number | null = null;
  private inFlight = false;
  /** Текущий прогон (с его же уборкой в finally); null — синка сейчас нет. */
  private chain: Promise<SyncRunResult> | null = null;
  /** Уже поставленный в очередь следующий прогон: глубже одного не копим. */
  private pending: Promise<SyncRunResult> | null = null;
  private baseIntervalMs = 5 * 60_000;
  private consecutiveErrors = 0;
  private readonly onProgress?: ProgressHandler;

  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly clientId: string,
    private apiBaseUrl: string,
    opts?: {
      onProgress?: ProgressHandler;
    },
  ) {
    this.onProgress = opts?.onProgress;
  }

  setApiBaseUrl(next: string) {
    this.apiBaseUrl = next;
  }

  getApiBaseUrl() {
    return this.apiBaseUrl;
  }

  private async refreshApiBaseUrlFromDb() {
    try {
      const next = (await settingsGetString(this.db, SettingsKey.ApiBaseUrl))?.trim() ?? '';
      if (next) this.apiBaseUrl = next;
    } catch {
      // ignore
    }
  }

  getStatus(): SyncStatus {
    const now = nowMs();
    const nextAutoSyncInMs = this.nextAt == null ? null : Math.max(0, this.nextAt - now);
    return {
      state: this.state,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
      nextAutoSyncInMs,
    };
  }

  startAuto(intervalMs: number) {
    this.baseIntervalMs = Math.max(10_000, Number(intervalMs) || 5 * 60_000);
    this.stopAuto();
    const scheduleNext = (delayMs: number) => {
      this.nextAt = nowMs() + delayMs;
      this.timer = setTimeout(() => {
        void this.tick(this.baseIntervalMs);
      }, delayMs);
    };
    scheduleNext(this.baseIntervalMs);
  }

  stopAuto() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  /**
   * Синхронизация «по требованию». Параллельных синков по-прежнему нет, но занятость
   * больше НЕ отвечает чужим результатом.
   *
   * Было: при идущем синке возвращался `lastResult` ПРОШЛОГО прогона — то есть на вопрос
   * «синхронизируй и скажи, как прошло» приходило бодрое `ok: true` от работы, которая
   * закончилась раньше, чем вызывающий вообще что-то изменил. Вызывающий верил и читал
   * реплику, где его данных ещё нет. Так ломалась дефектовка: личные номера экземпляров
   * появлялись со второго-третьего нажатия — не потому, что «долго считается», а потому
   * что показ опережал синк (GOTCHAS M134).
   *
   * Стало: обращение во время чужого синка ЖДЁТ его и запускает свежий — идущий мог
   * стартовать до изменения, которого ждёт вызывающий, и его результат ничего не
   * доказывает. Очередь глубиной один: десять нажатий подряд дают один догоняющий
   * прогон, а не десять.
   */
  async runOnce(opts?: Parameters<typeof runSync>[3]): Promise<SyncRunResult> {
    const current = this.chain;
    if (current) {
      if (this.pending) return this.pending;
      // Цепляемся за `current` — это прогон ВМЕСТЕ с его уборкой, поэтому к моменту
      // рекурсии `this.chain` уже пуст и новый прогон стартует, а не встаёт в очередь.
      const queued = current
        .catch(() => undefined)
        .then(() => {
          this.pending = null;
          return this.runOnce(opts);
        });
      this.pending = queued;
      return queued;
    }
    const run = this.runNow(opts).finally(() => {
      if (this.chain === run) this.chain = null;
    });
    this.chain = run;
    return run;
  }

  private async runNow(opts?: Parameters<typeof runSync>[3]): Promise<SyncRunResult> {
    this.inFlight = true;

    this.state = 'syncing';
    this.lastError = null;
    try {
      // UI читает apiBaseUrl из SQLite, а менеджер живёт в памяти.
      // Перед каждым синком подхватываем актуальную конфигурацию.
      await this.refreshApiBaseUrlFromDb();
      const r = await runSync(this.db, this.clientId, this.apiBaseUrl, opts);
      const offline = !r.ok && isOfflineSyncError(r.error ?? '');
      this.lastResult = r;
      if (r.ok) this.lastSyncAt = nowMs();
      // Ф2: досылаем снятия резерва, сделанные оффлайн у станка. Сеть только что
      // была — момент лучший. БЕЗ await: флеш ходит по сети, а мы ещё под inFlight,
      // и его ретраи задержали бы следующий синк на всё время недоступности сервера.
      if (r.ok) {
        void flushPendingEngineReservationReleases(this.db, this.db, this.apiBaseUrl).catch(() => 0);
      }
      this.state = r.ok || offline ? 'idle' : 'error';
      this.lastError = !r.ok && !offline ? (r.error ?? 'unknown') : null;
      return r;
    } finally {
      this.inFlight = false;
    }
  }

  private async tick(baseIntervalMs: number) {
    const startedAt = nowMs();
    const r = await this.runOnce({
      progress: {
        mode: 'incremental',
        startedAt,
        ...(this.onProgress ? { onProgress: this.onProgress } : {}),
      },
    });

    const offline = !r.ok && isOfflineSyncError(r.error ?? '');
    const { nextDelayMs, nextConsecutiveErrors } = computeNextSyncDelayMs({
      baseIntervalMs,
      resultOk: r.ok,
      pulled: Number(r.pulled ?? 0),
      pushed: Number(r.pushed ?? 0),
      offline,
      consecutiveErrors: this.consecutiveErrors,
    });
    this.consecutiveErrors = nextConsecutiveErrors;
    this.stopAuto();
    this.startAuto(nextDelayMs);
  }
}


