import { describe, expect, it } from 'vitest';

import { getNextAiRunAt, getPrevAiRunAt } from '@matricarmz/shared';

// МСК = UTC+3 (без DST). Утилита: собрать МСК-время как epoch ms.
function msk(y: number, m: number, d: number, h: number, min = 0): number {
  return Date.UTC(y, m - 1, d, h - 3, min);
}

describe('aiChatSchedule (Пн–Пт, 8:00–17:00 МСК, ежечасно)', () => {
  it('будний день внутри окна — следующий целый час', () => {
    // Ср 2026-07-15 10:30 МСК -> 11:00
    expect(getNextAiRunAt(msk(2026, 7, 15, 10, 30))).toBe(msk(2026, 7, 15, 11));
    // ровно в 11:00 -> следующий 12:00 (строго после now)
    expect(getNextAiRunAt(msk(2026, 7, 15, 11))).toBe(msk(2026, 7, 15, 12));
  });

  it('до окна и после окна', () => {
    // Ср 6:15 -> 8:00 того же дня
    expect(getNextAiRunAt(msk(2026, 7, 15, 6, 15))).toBe(msk(2026, 7, 15, 8));
    // Ср 17:30 -> Чт 8:00
    expect(getNextAiRunAt(msk(2026, 7, 15, 17, 30))).toBe(msk(2026, 7, 16, 8));
  });

  it('граница недели: Пт 17:00+ -> Пн 8:00', () => {
    // Пт 2026-07-17 17:00 -> Пн 2026-07-20 8:00
    expect(getNextAiRunAt(msk(2026, 7, 17, 17))).toBe(msk(2026, 7, 20, 8));
    // Сб/Вс -> Пн 8:00
    expect(getNextAiRunAt(msk(2026, 7, 18, 12))).toBe(msk(2026, 7, 20, 8));
    expect(getNextAiRunAt(msk(2026, 7, 19, 12))).toBe(msk(2026, 7, 20, 8));
  });

  it('getPrevAiRunAt: внутри окна, до окна, выходные', () => {
    // Ср 10:30 -> 10:00
    expect(getPrevAiRunAt(msk(2026, 7, 15, 10, 30))).toBe(msk(2026, 7, 15, 10));
    // Ср 6:15 -> Вт 17:00
    expect(getPrevAiRunAt(msk(2026, 7, 15, 6, 15))).toBe(msk(2026, 7, 14, 17));
    // Вс 12:00 -> Пт 17:00
    expect(getPrevAiRunAt(msk(2026, 7, 19, 12))).toBe(msk(2026, 7, 17, 17));
  });
});
