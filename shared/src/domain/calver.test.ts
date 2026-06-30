import { describe, expect, it } from 'vitest';

import { calverFromDate, compareCalver, formatCalverBuildDate, parseCalver } from './calver.js';

describe('calverFromDate', () => {
  it('formats date as YYYY.(MM*100+DD).(HH*100+MM)', () => {
    expect(calverFromDate(new Date(2026, 5, 14, 15, 30))).toBe('2026.614.1530');
  });

  it('emits no leading zeros (valid semver) for single-digit month/day/time', () => {
    const v = calverFromDate(new Date(2026, 0, 5, 9, 5)); // 5 Jan 2026 09:05
    expect(v).toBe('2026.105.905');
    for (const seg of v.split('.')) {
      expect(seg.length === 1 || !seg.startsWith('0')).toBe(true);
    }
  });

  it('handles midnight (00:00 → segment 0)', () => {
    expect(calverFromDate(new Date(2026, 11, 31, 0, 0))).toBe('2026.1231.0');
  });

  it('is monotonic across time within a year (numeric segment compare)', () => {
    const seg = (v: string) => v.split('.').map(Number);
    const a = seg(calverFromDate(new Date(2026, 5, 14, 15, 30)));
    const b = seg(calverFromDate(new Date(2026, 5, 14, 15, 31)));
    const c = seg(calverFromDate(new Date(2026, 5, 15, 9, 0)));
    const d = seg(calverFromDate(new Date(2026, 6, 1, 9, 0)));
    expect(b[2]).toBeGreaterThan(a[2]); // later minute → larger patch
    expect(c[1]).toBeGreaterThan(a[1]); // next day → larger minor
    expect(d[1]).toBeGreaterThan(c[1]); // next month → larger minor
  });

  it('sorts above legacy 1.x by major (year) for update detection', () => {
    expect(Number(calverFromDate(new Date(2026, 5, 14, 0, 0)).split('.')[0])).toBeGreaterThan(1);
  });
});

describe('parseCalver / formatCalverBuildDate', () => {
  it('round-trips date fields', () => {
    const d = new Date(2026, 5, 14, 15, 30);
    const p = parseCalver(calverFromDate(d));
    expect(p).toEqual({ year: 2026, month: 6, day: 14, hour: 15, minute: 30 });
  });

  it('formats a human build date', () => {
    expect(formatCalverBuildDate('2026.614.1530')).toBe('14.06.2026 15:30');
    expect(formatCalverBuildDate('2026.105.905')).toBe('05.01.2026 09:05');
  });

  it('returns null for legacy semver (1.x) so callers fall back to the raw string', () => {
    expect(parseCalver('1.55.0')).toBeNull();
    expect(formatCalverBuildDate('1.55.0')).toBeNull();
    expect(formatCalverBuildDate('not-a-version')).toBeNull();
  });
});

describe('compareCalver', () => {
  it('orders by year → month-day → hour-minute', () => {
    expect(compareCalver('2026.622.1241', '2026.622.1242')).toBe(-1); // later minute
    expect(compareCalver('2026.622.1242', '2026.622.1241')).toBe(1);
    expect(compareCalver('2026.622.1241', '2026.623.0')).toBe(-1); // next day
    expect(compareCalver('2027.101.0', '2026.1231.2359')).toBe(1); // next year
    expect(compareCalver('2026.622.1241', '2026.622.1241')).toBe(0);
  });

  it('returns null when either side is not CalVer', () => {
    expect(compareCalver('1.55.0', '2026.622.1241')).toBeNull();
    expect(compareCalver('2026.622.1241', '')).toBeNull();
  });
});
