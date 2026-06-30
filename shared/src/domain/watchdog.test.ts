import { describe, expect, it } from 'vitest';

import { WATCHDOG_ROLLOUT_AFTER_VERSION, clientHasWatchdog } from './watchdog.js';

describe('clientHasWatchdog', () => {
  it('is true only for builds strictly newer than the rollout boundary', () => {
    expect(clientHasWatchdog('2026.622.1242')).toBe(true); // one minute after
    expect(clientHasWatchdog('2026.623.900')).toBe(true); // next day
    expect(clientHasWatchdog('2027.101.0')).toBe(true); // next year
  });

  it('is false for the boundary release itself and older', () => {
    expect(clientHasWatchdog(WATCHDOG_ROLLOUT_AFTER_VERSION)).toBe(false); // 2026.622.1241
    expect(clientHasWatchdog('2026.621.1815')).toBe(false);
  });

  it('is false for unknown / legacy / absent versions', () => {
    expect(clientHasWatchdog('1.55.0')).toBe(false);
    expect(clientHasWatchdog(null)).toBe(false);
    expect(clientHasWatchdog(undefined)).toBe(false);
    expect(clientHasWatchdog('')).toBe(false);
  });
});
