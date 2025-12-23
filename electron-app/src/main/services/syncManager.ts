import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SyncRunResult, SyncStatus } from '@matricarmz/shared';

import { runSync } from './syncService.js';

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

  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly clientId: string,
    private apiBaseUrl: string,
  ) {}

  setApiBaseUrl(next: string) {
    this.apiBaseUrl = next;
  }

  getApiBaseUrl() {
    return this.apiBaseUrl;
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
    this.stopAuto();
    const scheduleNext = (delayMs: number) => {
      this.nextAt = nowMs() + delayMs;
      this.timer = setTimeout(() => {
        void this.tick(intervalMs);
      }, delayMs);
    };
    scheduleNext(intervalMs);
  }

  stopAuto() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  async runOnce(): Promise<SyncRunResult> {
    // Не запускаем параллельные синки.
    if (this.inFlight) return this.lastResult ?? { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: 'sync busy' };
    this.inFlight = true;

    this.state = 'syncing';
    this.lastError = null;
    try {
      const r = await runSync(this.db, this.clientId, this.apiBaseUrl);
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
    const r = await this.runOnce();

    // Простая политика backoff: при ошибке увеличиваем интервал до 60s→120s→300s→600s (макс).
    const nextDelay = r.ok ? baseIntervalMs : Math.min(600_000, Math.max(60_000, baseIntervalMs));
    this.stopAuto();
    this.startAuto(nextDelay);
  }
}


