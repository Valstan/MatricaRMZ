import { describe, expect, it, vi } from 'vitest';

// employeeAuthService pulls in the pg-backed db transitively; stub it so importing
// the module does not construct a real connection pool. The function under test
// (shouldRevokeRefreshTokensOnAuthChange) is pure.
vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));

const { shouldRevokeRefreshTokensOnAuthChange } = await import('./employeeAuthService.js');

describe('shouldRevokeRefreshTokensOnAuthChange — session hygiene', () => {
  it('revokes on a password change (incl. clearing the hash)', () => {
    expect(shouldRevokeRefreshTokensOnAuthChange({ passwordHash: 'new-hash' })).toBe(true);
    expect(shouldRevokeRefreshTokensOnAuthChange({ passwordHash: null })).toBe(true);
  });

  it('revokes when the account is disabled', () => {
    expect(shouldRevokeRefreshTokensOnAuthChange({ accessEnabled: false })).toBe(true);
  });

  it('does NOT revoke on role/login-only changes or on re-enable', () => {
    expect(shouldRevokeRefreshTokensOnAuthChange({ systemRole: 'admin' })).toBe(false);
    expect(shouldRevokeRefreshTokensOnAuthChange({ login: 'new-login' })).toBe(false);
    expect(shouldRevokeRefreshTokensOnAuthChange({ accessEnabled: true })).toBe(false);
    expect(shouldRevokeRefreshTokensOnAuthChange({})).toBe(false);
  });
});
