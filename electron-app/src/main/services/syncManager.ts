import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SyncRunResult, SyncStatus } from '@matricarmz/shared';

import { runSync } from './syncService.js';
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
      this.lastResult = r;
      this.lastSyncAt = nowMs();
      this.state = r.ok ? 'idle' : 'error';
      if (!r.ok) this.lastError = r.error ?? 'unknown';
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
        onProgress: this.onProgress,
      },
    });

    let nextDelay = baseIntervalMs;
    if (!r.ok) {
      this.consecutiveErrors += 1;
      const backoff = Math.min(10 * 60_000, 30_000 * 2 ** Math.min(4, this.consecutiveErrors - 1));
      nextDelay = Math.max(30_000, backoff);
    } else {
      this.consecutiveErrors = 0;
      const activity = Number(r.pulled ?? 0) + Number(r.pushed ?? 0);
      // Если были изменения — повторяем быстрее, чтобы «догрызать хвост».
      nextDelay = activity > 0 ? Math.min(45_000, Math.max(15_000, Math.floor(baseIntervalMs / 3))) : baseIntervalMs;
    }
    // Добавляем jitter, чтобы клиенты не били сервер одновременно.
    const jitter = Math.floor(nextDelay * 0.15 * Math.random());
    nextDelay = Math.max(10_000, nextDelay + jitter);
    this.stopAuto();
    this.startAuto(nextDelay);
  }
}


