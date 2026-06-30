import { describe, expect, it } from 'vitest';

import { accrueActive } from './activityTracker.js';

const TICK = 30_000;
const IDLE = 5 * 60_000;
const base = { tickMs: TICK, idleMs: IDLE };

describe('accrueActive', () => {
  it('accrues a tick when active and visible', () => {
    const s = accrueActive(
      { activeDate: '2026-06-20', activeMs: 0 },
      { now: 1000, lastInputAt: 1000, visible: true, today: '2026-06-20', ...base },
    );
    expect(s).toEqual({ activeDate: '2026-06-20', activeMs: TICK });
  });

  it('does not accrue when idle (no input within idleMs)', () => {
    const s = accrueActive(
      { activeDate: '2026-06-20', activeMs: TICK },
      { now: 10 * 60_000, lastInputAt: 0, visible: true, today: '2026-06-20', ...base },
    );
    expect(s.activeMs).toBe(TICK);
  });

  it('does not accrue when the window is hidden', () => {
    const s = accrueActive(
      { activeDate: '2026-06-20', activeMs: TICK },
      { now: 1000, lastInputAt: 1000, visible: false, today: '2026-06-20', ...base },
    );
    expect(s.activeMs).toBe(TICK);
  });

  it('resets the accumulator on local-day change (midnight rollover)', () => {
    const s = accrueActive(
      { activeDate: '2026-06-20', activeMs: 5 * TICK },
      { now: 1000, lastInputAt: 1000, visible: true, today: '2026-06-21', ...base },
    );
    expect(s).toEqual({ activeDate: '2026-06-21', activeMs: TICK });
  });
});
