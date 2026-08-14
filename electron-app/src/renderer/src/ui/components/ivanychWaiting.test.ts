import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IVANYCH_FIRST_ANSWER_POLL_DELAY_MS,
  IVANYCH_NEXT_ANSWER_POLL_DELAY_MS,
  ivanychWaitingText,
  startIvanychAnswerPolling,
} from './ivanychWaiting.js';

afterEach(() => vi.useRealTimers());

describe('ivanych waiting presentation', () => {
  it('keeps the requested polling cadence', () => {
    expect(IVANYCH_FIRST_ANSWER_POLL_DELAY_MS).toBe(15_000);
    expect(IVANYCH_NEXT_ANSWER_POLL_DELAY_MS).toBe(5_000);
  });

  it('changes the local status after every completed poll', () => {
    const texts = Array.from({ length: 7 }, (_, index) => ivanychWaitingText('processing', index));
    expect(new Set(texts.slice(0, 6)).size).toBe(6);
    expect(texts[0]).toContain('15 секунд');
    expect(texts[1]).toContain('проверяю');
    expect(texts[6]).toContain('жду готовый ответ');
  });

  it('waits 15 seconds, then waits 5 seconds after each completed poll', async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => undefined);
    const onCompleted = vi.fn();
    const stop = startIvanychAnswerPolling(poll, onCompleted);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);

    stop();
  });
});
