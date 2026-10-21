import { describe, expect, it } from 'vitest';

import {
  CLOCK_SKEW_THRESHOLD_MS,
  clockSkewIsProblem,
  computeClockSkew,
  formatClockSkew,
} from './clockSkew.js';

describe('расхождение часов', () => {
  it('порог — две минуты', () => {
    expect(CLOCK_SKEW_THRESHOLD_MS).toBe(2 * 60 * 1000);
  });

  it('середина RTT: сетевая задержка не съедает половину ошибки', () => {
    // Отправили в 0, получили в 1000 (RTT 1 с), сервер ответил своим 2000.
    // Наш компьютер в середине обмена «показывает» 500 → расхождение 1500, а не 2000.
    const { skewMs, rttMs } = computeClockSkew(0, 2000, 1000);
    expect(rttMs).toBe(1000);
    expect(skewMs).toBe(1500);
  });

  it('без задержки расхождение считается точно', () => {
    expect(computeClockSkew(1000, 1000 + 60_000, 1000).skewMs).toBe(60_000);
  });

  it('предупреждаем только когда расхождение больше порога', () => {
    expect(clockSkewIsProblem(CLOCK_SKEW_THRESHOLD_MS)).toBe(false);
    expect(clockSkewIsProblem(CLOCK_SKEW_THRESHOLD_MS + 1)).toBe(true);
    expect(clockSkewIsProblem(-(CLOCK_SKEW_THRESHOLD_MS + 1))).toBe(true);
    expect(clockSkewIsProblem(null)).toBe(false);
  });

  it('человекочитаемо: минуты и часы', () => {
    expect(formatClockSkew(30_000)).toBe('меньше минуты');
    expect(formatClockSkew(5 * 60_000)).toBe('5 мин');
    expect(formatClockSkew(90 * 60_000)).toBe('1 ч 30 мин');
    expect(formatClockSkew(120 * 60_000)).toBe('2 ч');
    expect(formatClockSkew(null)).toBe('—');
  });
});
