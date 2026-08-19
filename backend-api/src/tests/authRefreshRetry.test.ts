import { describe, expect, it } from 'vitest';

import { REFRESH_ROTATION_GRACE_MS, isTransientRefreshDbError, refreshRotationGraceExpiry } from '../routes/auth.js';

describe('auth refresh transient DB error detection', () => {
  it('matches transient connection/timeout errors', () => {
    expect(isTransientRefreshDbError('timeout exceeded when trying to connect')).toBe(true);
    expect(isTransientRefreshDbError('ECONNREFUSED 127.0.0.1:5432')).toBe(true);
    expect(isTransientRefreshDbError('ETIMEDOUT while connecting')).toBe(true);
    expect(isTransientRefreshDbError('connection reset by peer')).toBe(true);
  });

  it('does not match non-transient auth errors', () => {
    expect(isTransientRefreshDbError('invalid refresh token')).toBe(false);
    expect(isTransientRefreshDbError('permission denied')).toBe(false);
  });
});

describe('refresh rotation grace window', () => {
  it('keeps the rotated-out token alive for the grace period', () => {
    const now = 1_000_000;
    const farExpiry = now + 30 * 24 * 60 * 60 * 1000;
    expect(refreshRotationGraceExpiry(farExpiry, now)).toBe(now + REFRESH_ROTATION_GRACE_MS);
  });

  it('never extends a token beyond its own TTL', () => {
    const now = 1_000_000;
    const nearExpiry = now + 10_000; // expires sooner than the grace window
    expect(refreshRotationGraceExpiry(nearExpiry, now)).toBe(nearExpiry);
  });
});

