import { describe, expect, it } from 'vitest';

import { computeNextSyncDelayMs } from './syncScheduling.js';

describe('syncScheduling', () => {
  it('uses soft retry window for offline result', () => {
    const next = computeNextSyncDelayMs({
      baseIntervalMs: 5 * 60_000,
      resultOk: false,
      pulled: 0,
      pushed: 0,
      offline: true,
      consecutiveErrors: 3,
      random: () => 0,
    });
    expect(next.nextConsecutiveErrors).toBe(0);
    expect(next.nextDelayMs).toBe(60_000);
  });

  it('applies exponential backoff for online errors', () => {
    const first = computeNextSyncDelayMs({
      baseIntervalMs: 5 * 60_000,
      resultOk: false,
      pulled: 0,
      pushed: 0,
      offline: false,
      consecutiveErrors: 0,
      random: () => 0,
    });
    expect(first.nextConsecutiveErrors).toBe(1);
    expect(first.nextDelayMs).toBe(30_000);

    const second = computeNextSyncDelayMs({
      baseIntervalMs: 5 * 60_000,
      resultOk: false,
      pulled: 0,
      pushed: 0,
      offline: false,
      consecutiveErrors: 1,
      random: () => 0,
    });
    expect(second.nextConsecutiveErrors).toBe(2);
    expect(second.nextDelayMs).toBe(60_000);
  });

  it('uses faster cycle when sync has activity', () => {
    const next = computeNextSyncDelayMs({
      baseIntervalMs: 5 * 60_000,
      resultOk: true,
      pulled: 10,
      pushed: 2,
      offline: false,
      consecutiveErrors: 2,
      random: () => 0,
    });
    expect(next.nextConsecutiveErrors).toBe(0);
    expect(next.nextDelayMs).toBe(45_000);
  });

  it('uses base interval when sync is idle', () => {
    const next = computeNextSyncDelayMs({
      baseIntervalMs: 5 * 60_000,
      resultOk: true,
      pulled: 0,
      pushed: 0,
      offline: false,
      consecutiveErrors: 2,
      random: () => 0,
    });
    expect(next.nextConsecutiveErrors).toBe(0);
    expect(next.nextDelayMs).toBe(5 * 60_000);
  });
});

