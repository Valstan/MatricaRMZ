import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SyncRunResult, SyncStatus } from '@matricarmz/shared';

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

  async runOnce(opts?: Parameters<typeof runSync>[3]): Promise<SyncRunResult> {
    // Не запускаем параллельные синки.
    if (this.inFlight) return this.lastResult ?? { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: 'sync busy' };
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


