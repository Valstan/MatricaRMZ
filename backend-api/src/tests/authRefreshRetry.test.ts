import { describe, expect, it } from 'vitest';

import { isTransientRefreshDbError } from '../routes/auth.js';

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

