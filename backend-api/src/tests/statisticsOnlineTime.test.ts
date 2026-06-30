import { describe, expect, it } from 'vitest';

import { sessionizeOnlineMs } from '../services/statisticsAuditService.js';

const H = 60 * 60 * 1000;
const M = 60 * 1000;
const T0 = 1_700_000_000_000; // arbitrary day start
const GRACE = 2 * M;

const start = (at: number) => ({ at, action: 'app.session.start' });
const stop = (at: number) => ({ at, action: 'app.session.stop' });

describe('sessionizeOnlineMs', () => {
  it('just opened (open session, heartbeat ~ now) → ~0, not the window end', () => {
    const opened = T0 + 9 * H;
    const now = opened + 30_000; // 30s later
    const ms = sessionizeOnlineMs([start(opened)], {
      windowStart: T0,
      windowEnd: now,
      lastSeenAt: now,
      graceMs: GRACE,
    });
    expect(ms).toBeLessThan(3 * M); // ~30s + grace, NOT 10h
  });

  it('open session is bounded by the last heartbeat, not by the window end (crash case)', () => {
    const opened = T0 + 8 * H;
    const lastSeenAt = opened + 1 * H; // last beat 1h in, then the client died
    const now = opened + 5 * H; // recompute runs 5h later
    const ms = sessionizeOnlineMs([start(opened)], {
      windowStart: T0,
      windowEnd: now,
      lastSeenAt,
      graceMs: GRACE,
    });
    expect(ms).toBe(1 * H + GRACE); // ends at lastSeen+grace, not 5h
  });

  it('closed session = stop - start', () => {
    const ms = sessionizeOnlineMs([start(T0 + 8 * H), stop(T0 + 10 * H)], {
      windowStart: T0,
      windowEnd: T0 + 24 * H,
      lastSeenAt: 0,
      graceMs: GRACE,
    });
    expect(ms).toBe(2 * H);
  });

  it('clips a session to the window bounds', () => {
    const ms = sessionizeOnlineMs([start(T0 - 1 * H), stop(T0 + 25 * H)], {
      windowStart: T0,
      windowEnd: T0 + 10 * H,
      lastSeenAt: 0,
      graceMs: GRACE,
    });
    expect(ms).toBe(10 * H);
  });

  it('sums two sessions and ignores an unmatched stop', () => {
    const ms = sessionizeOnlineMs(
      [
        start(T0 + 8 * H),
        stop(T0 + 9 * H),
        stop(T0 + 9.5 * H), // unmatched
        start(T0 + 11 * H),
        stop(T0 + 12 * H),
      ],
      { windowStart: T0, windowEnd: T0 + 24 * H, lastSeenAt: 0, graceMs: GRACE },
    );
    expect(ms).toBe(2 * H);
  });

  it('returns 0 for an empty event list', () => {
    expect(sessionizeOnlineMs([], { windowStart: T0, windowEnd: T0 + 10 * H, lastSeenAt: 0, graceMs: GRACE })).toBe(0);
  });
});
