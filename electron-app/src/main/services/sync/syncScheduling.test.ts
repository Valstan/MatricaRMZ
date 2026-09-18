import { describe, expect, it } from 'vitest';

import { computeLocalDirtyAction, computeNextSyncDelayMs, computeWakeIdlePauseMs } from './syncScheduling.js';

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

describe('сторож своих правок', () => {
  const base = {
    nowMs: 10_000,
    lastDirtySyncAtMs: null,
    retryDelayMs: 5_000,
    minRetryDelayMs: 5_000,
    maxRetryDelayMs: 60_000,
  };

  it('чисто — синк не нужен, пауза повтора сброшена', () => {
    const r = computeLocalDirtyAction({ ...base, pendingRows: 0, lastPendingRows: 4, retryDelayMs: 40_000 });
    expect(r).toEqual({ sync: false, nextRetryDelayMs: 5_000 });
  });

  it('появилась своя запись — синк немедленно', () => {
    const r = computeLocalDirtyAction({ ...base, pendingRows: 1, lastPendingRows: 0 });
    expect(r.sync).toBe(true);
  });

  it('первый взгляд на непустую очередь — тоже синк', () => {
    const r = computeLocalDirtyAction({ ...base, pendingRows: 2, lastPendingRows: null });
    expect(r.sync).toBe(true);
  });

  it('то же число строк сразу после попытки — ждём, а не крутимся', () => {
    const r = computeLocalDirtyAction({ ...base, pendingRows: 2, lastPendingRows: 2, lastDirtySyncAtMs: 9_000 });
    expect(r).toEqual({ sync: false, nextRetryDelayMs: 5_000 });
  });

  it('строка, которую сервер не принимает, переспрашивается всё реже — до потолка', () => {
    const first = computeLocalDirtyAction({
      ...base,
      pendingRows: 2,
      lastPendingRows: 2,
      lastDirtySyncAtMs: 1_000,
      nowMs: 10_000,
    });
    expect(first).toEqual({ sync: true, nextRetryDelayMs: 10_000 });
    const capped = computeLocalDirtyAction({
      ...base,
      pendingRows: 2,
      lastPendingRows: 2,
      lastDirtySyncAtMs: 0,
      nowMs: 10_000_000,
      retryDelayMs: 60_000,
    });
    expect(capped).toEqual({ sync: true, nextRetryDelayMs: 60_000 });
  });

  it('сорванная проба (-1) не считается «чисто» и не двигает паузу', () => {
    const r = computeLocalDirtyAction({ ...base, pendingRows: -1, lastPendingRows: 3, retryDelayMs: 20_000 });
    expect(r).toEqual({ sync: false, nextRetryDelayMs: 20_000 });
  });
});

describe('темп ждущего запроса', () => {
  it('сервер ответил пустым мгновенно — добираем остаток окна, а не крутим петлю', () => {
    expect(computeWakeIdlePauseMs(5, 25_000)).toBe(24_995);
  });

  it('сервер честно держал окно — паузы нет', () => {
    expect(computeWakeIdlePauseMs(25_010, 25_000)).toBe(0);
  });

  it('отрицательные и мусорные длительности не дают отрицательной паузы', () => {
    expect(computeWakeIdlePauseMs(-100, 25_000)).toBe(25_000);
    expect(computeWakeIdlePauseMs(100, -5)).toBe(0);
  });
});
