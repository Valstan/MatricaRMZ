import { describe, expect, it } from 'vitest';

import { formatDateInputValue, parseDateInputValue } from './UnifiedDateInput.js';

describe('UnifiedDateInput local values', () => {
  it('round-trips a date-time through local calendar fields', () => {
    const parsed = parseDateInputValue('2026-07-24T08:15', true);
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(6);
    expect(parsed?.getDate()).toBe(24);
    expect(parsed?.getHours()).toBe(8);
    expect(formatDateInputValue(parsed, true)).toBe('2026-07-24T08:15');
  });

  it('formats a date without UTC conversion', () => {
    expect(formatDateInputValue(new Date(2026, 6, 24, 23, 30), false)).toBe('2026-07-24');
  });
});
