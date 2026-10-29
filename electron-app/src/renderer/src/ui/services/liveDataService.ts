import type { SyncProgressEvent } from '@matricarmz/shared';

type LiveDataPulseReason = 'interval' | 'focus' | 'visibility' | 'sync_done';

export type LiveDataPulse = {
  at: number;
  reason: LiveDataPulseReason;
  pulled?: number;
  /** Таблицы контракта, которые задел прогон. Пусто/нет — «неизвестно, считай все». */
  tables?: string[];
};

type PulseListener = (pulse: LiveDataPulse) => void;

class LiveDataService {
  private listeners = new Set<PulseListener>();
  private intervalId: number | null = null;
  private unsubscribeSync: (() => void) | null = null;
  private started = false;
  private readonly intervalMs = 15_000;

  private emit(reason: LiveDataPulseReason, extras?: Partial<LiveDataPulse>) {
    const pulse: LiveDataPulse = { at: Date.now(), reason, ...(extras ?? {}) };
    for (const listener of this.listeners) {
      listener(pulse);
    }
  }

  private handleFocus = () => {
    this.emit('focus');
  };

  private handleVisibility = () => {
    if (document.visibilityState === 'visible') this.emit('visibility');
  };

  private start() {
    if (this.started) return;
    this.started = true;
    this.intervalId = window.setInterval(() => this.emit('interval'), this.intervalMs);
    window.addEventListener('focus', this.handleFocus);
    document.addEventListener('visibilitychange', this.handleVisibility);
    if (window.matrica?.sync?.onProgress) {
      this.unsubscribeSync = window.matrica.sync.onProgress((evt: SyncProgressEvent) => {
        if (!evt) return;
        if (evt.state === 'done') {
          const tables = evt.counts?.tables ? Object.keys(evt.counts.tables) : null;
          this.emit('sync_done', {
            pulled: Number(evt.pulled ?? 0),
            ...(tables && tables.length > 0 ? { tables } : {}),
          });
        }
      });
    }
  }

  private stop() {
    if (!this.started) return;
    this.started = false;
    if (this.intervalId != null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    window.removeEventListener('focus', this.handleFocus);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    if (this.unsubscribeSync) {
      this.unsubscribeSync();
      this.unsubscribeSync = null;
    }
  }

  subscribe(listener: PulseListener) {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }
}

const liveDataService = new LiveDataService();

export function subscribeLiveDataPulse(listener: PulseListener) {
  return liveDataService.subscribe(listener);
}

