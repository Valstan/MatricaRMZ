/**
 * Progress event emitter for sync UI feedback.
 */
import type { SyncProgressEvent, RunSyncOptions } from './types.js';

export function nowMs() {
  return Date.now();
}

export function yieldToEventLoop() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function createProgressEmitter(opts?: RunSyncOptions) {
  const fullPull = opts?.fullPull ?? null;
  const progressMode: SyncProgressEvent['mode'] = fullPull ? 'force_full_pull' : 'incremental';
  const startedAt = fullPull?.startedAt ?? opts?.progress?.startedAt ?? nowMs();
  const estimateMs = fullPull ? fullPull.estimateMs : null;
  const emitter = fullPull?.onProgress ?? opts?.progress?.onProgress;

  function emit(state: SyncProgressEvent['state'], extra?: Partial<SyncProgressEvent>) {
    if (!emitter) return;
    const now = nowMs();
    const elapsedMs = Math.max(0, now - startedAt);
    const safeEstimate = Number.isFinite(estimateMs) ? Math.max(0, Number(estimateMs)) : null;
    const timedProgress = safeEstimate && safeEstimate > 0 ? Math.min(0.99, elapsedMs / safeEstimate) : null;
    const progress = extra?.progress != null ? extra.progress : timedProgress;
    const etaMs = safeEstimate && safeEstimate > 0 ? Math.max(0, safeEstimate - elapsedMs) : null;
    emitter({
      mode: progressMode,
      state,
      startedAt,
      elapsedMs,
      estimateMs: safeEstimate,
      etaMs,
      progress,
      ...extra,
    });
  }

  return { emit, startedAt, progressMode };
}
