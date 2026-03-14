import { beforeEach, describe, expect, it } from 'vitest';

import {
  classifySyncPipelineBotPollError,
  getSyncPipelineBotPollMetrics,
  markSyncPipelineBotPollAttempt,
  markSyncPipelineBotPollFailure,
  markSyncPipelineBotPollSuccess,
  resetSyncPipelineBotPollMetricsForTests,
} from '../services/syncPipelineBotPollMetricsService.js';

describe('sync pipeline bot poll metrics', () => {
  beforeEach(() => {
    resetSyncPipelineBotPollMetricsForTests();
  });

  it('classifies polling errors by operational kind', () => {
    expect(
      classifySyncPipelineBotPollError(
        'telegram HTTP 409: {"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request"}',
      ),
    ).toBe('conflict');
    expect(classifySyncPipelineBotPollError('TypeError: fetch failed')).toBe('transient');
    expect(classifySyncPipelineBotPollError('telegram HTTP 401: Unauthorized')).toBe('misconfigured');
    expect(classifySyncPipelineBotPollError('telegram HTTP 418: teapot')).toBe('other');
  });

  it('tracks attempts, failure buckets and streak recovery', () => {
    markSyncPipelineBotPollAttempt();
    markSyncPipelineBotPollFailure('TypeError: fetch failed');
    markSyncPipelineBotPollAttempt();
    markSyncPipelineBotPollFailure('telegram HTTP 409: terminated by other getUpdates request');

    let metrics = getSyncPipelineBotPollMetrics();
    expect(metrics.totalAttempts).toBe(2);
    expect(metrics.totalFailures).toBe(2);
    expect(metrics.transientFailures).toBe(1);
    expect(metrics.conflictFailures).toBe(1);
    expect(metrics.currentFailureStreak).toBe(2);
    expect(metrics.maxFailureStreak).toBe(2);
    expect(metrics.lastError).toContain('getUpdates');
    expect(metrics.lastErrorAt).not.toBeNull();
    expect(metrics.lastSuccessAt).toBeNull();

    markSyncPipelineBotPollAttempt();
    markSyncPipelineBotPollSuccess();

    metrics = getSyncPipelineBotPollMetrics();
    expect(metrics.totalAttempts).toBe(3);
    expect(metrics.totalFailures).toBe(2);
    expect(metrics.currentFailureStreak).toBe(0);
    expect(metrics.maxFailureStreak).toBe(2);
    expect(metrics.lastSuccessAt).not.toBeNull();
  });

  it('tracks misconfigured and other failures separately', () => {
    markSyncPipelineBotPollAttempt();
    markSyncPipelineBotPollFailure('telegram HTTP 401: Unauthorized');
    markSyncPipelineBotPollAttempt();
    markSyncPipelineBotPollFailure('telegram HTTP 418: teapot');

    const metrics = getSyncPipelineBotPollMetrics();
    expect(metrics.misconfiguredFailures).toBe(1);
    expect(metrics.otherFailures).toBe(1);
    expect(metrics.totalFailures).toBe(2);
    expect(metrics.currentFailureStreak).toBe(2);
  });
});

