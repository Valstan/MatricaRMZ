import { describe, expect, it } from 'vitest';

import {
  STUCK_PENDING_MINUTES,
  emptyStuckPendingSummary,
  isStuckPending,
  stuckAgeMinutes,
  stuckPendingCutoff,
} from './stuckPending.js';

describe('порог «застряло»', () => {
  it('по умолчанию 15 минут — синк ходит раз в минуту, строка старше — уже не в пути', () => {
    expect(STUCK_PENDING_MINUTES).toBe(15);
  });

  it('отсечка отступает на порог назад', () => {
    const now = 1_700_000_000_000;
    expect(stuckPendingCutoff(now)).toBe(now - 15 * 60_000);
    expect(stuckPendingCutoff(now, 30)).toBe(now - 30 * 60_000);
  });

  it('строка старше отсечки — застряла, свежая — нет', () => {
    const now = 1_700_000_000_000;
    expect(isStuckPending(now - 20 * 60_000, now)).toBe(true);
    expect(isStuckPending(now - 14 * 60_000, now)).toBe(false);
    expect(isStuckPending(now, now)).toBe(false);
  });

  it('без времени правки строка застрявшей не считается — неизвестное не страшнее нуля', () => {
    const now = 1_700_000_000_000;
    expect(isStuckPending(null, now)).toBe(false);
    expect(isStuckPending(undefined, now)).toBe(false);
    expect(isStuckPending(0, now)).toBe(false);
    expect(isStuckPending(Number.NaN, now)).toBe(false);
  });

  it('пустая сводка честная: ноль и нет времени', () => {
    expect(emptyStuckPendingSummary()).toEqual({ count: 0, oldestPendingAt: null, thresholdMinutes: 15 });
  });

  it('возраст в минутах округляется вверх — меньше минуты тоже говорим', () => {
    const now = 1_700_000_000_000;
    expect(stuckAgeMinutes(now - 30_000, now)).toBe(1);
    expect(stuckAgeMinutes(now - 5 * 60_000, now)).toBe(5);
    expect(stuckAgeMinutes(null, now)).toBe(0);
  });
});
