import { describe, expect, it } from 'vitest';

import { formatChatDaySeparator, moscowDayKey } from './dateUtils.js';

// Лента чата режется на дни по МОСКОВСКИМ суткам: у машин в разных поясах
// разделители обязаны стоять в одних и тех же местах одной переписки.

describe('moscowDayKey', () => {
  it('groups by the Moscow day, not the local one', () => {
    // 2026-08-19 21:30 UTC = 2026-08-20 00:30 МСК → уже следующие сутки.
    expect(moscowDayKey(Date.parse('2026-08-19T21:30:00Z'))).toBe('2026-08-20');
    // 2026-08-19 20:30 UTC = 23:30 МСК → те же сутки.
    expect(moscowDayKey(Date.parse('2026-08-19T20:30:00Z'))).toBe('2026-08-19');
  });

  it('two moments of the same Moscow day share a key', () => {
    const a = moscowDayKey(Date.parse('2026-08-19T05:00:00Z'));
    const b = moscowDayKey(Date.parse('2026-08-19T18:00:00Z'));
    expect(a).toBe(b);
  });
});

describe('formatChatDaySeparator', () => {
  const now = Date.parse('2026-08-19T12:00:00Z'); // 15:00 МСК

  it('says «Сегодня» / «Вчера» for the two nearest days', () => {
    expect(formatChatDaySeparator(Date.parse('2026-08-19T06:00:00Z'), now)).toBe('Сегодня');
    expect(formatChatDaySeparator(Date.parse('2026-08-18T06:00:00Z'), now)).toBe('Вчера');
  });

  it('spells older days out in Russian without the «г.» tail', () => {
    const label = formatChatDaySeparator(Date.parse('2026-08-15T06:00:00Z'), now);
    expect(label).toBe('15 августа 2026');
  });

  it('a late-evening message belongs to the next Moscow day', () => {
    // 2026-08-19 22:10 UTC = 2026-08-20 01:10 МСК — для «сегодня 19-го» это уже завтра.
    expect(formatChatDaySeparator(Date.parse('2026-08-19T22:10:00Z'), now)).toBe('20 августа 2026');
  });
});
