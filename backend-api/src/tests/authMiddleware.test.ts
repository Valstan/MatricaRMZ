import { beforeEach, describe, expect, it, vi } from 'vitest';

// requireAuth must distinguish "the session is definitively invalid" (401/403)
// from "the auth backend is temporarily sick" (503). Clients clear the stored
// session only on definitive verdicts; answering 401/403 on infra errors was
// the M28 tail that logged whole shifts out during backend hiccups.

const { verifyAccessToken, getEmployeeAuthById, normalizeRole } = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  getEmployeeAuthById: vi.fn(),
  normalizeRole: vi.fn(() => 'admin'),
}));

vi.mock('../auth/jwt.js', () => ({ verifyAccessToken }));
vi.mock('../auth/permissions.js', () => ({ hasPermission: vi.fn(async () => true) }));
vi.mock('../services/authzDenialLog.js', () => ({ recordRestAuthzDenial: vi.fn() }));
vi.mock('../services/employeeAuthService.js', () => ({ getEmployeeAuthById, normalizeRole }));

import { requireAuth } from '../auth/middleware.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function makeReq(authHeader?: string) {
  return {
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authHeader : undefined),
  } as any;
}

function makeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

beforeEach(() => {
  verifyAccessToken.mockReset();
  getEmployeeAuthById.mockReset();
  normalizeRole.mockClear();
});

describe('requireAuth verdicts', () => {
  it('401 token_missing without a bearer token', async () => {
    const res = makeRes();
    await requireAuth(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('token_missing');
  });

  it('401 token_invalid when the token does not verify', async () => {
    verifyAccessToken.mockRejectedValue(new Error('bad signature'));
    const res = makeRes();
    await requireAuth(makeReq('Bearer x'), res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('token_invalid');
  });

  it('503 (not 401) when loading employee auth throws', async () => {
    verifyAccessToken.mockResolvedValue({ id: USER_ID, username: 'u', role: 'admin' });
    getEmployeeAuthById.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432'));
    const res = makeRes();
    await requireAuth(makeReq('Bearer x'), res, vi.fn());
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('auth_backend_unavailable');
  });

  it('503 (not 403 user disabled) when auth defs are unavailable', async () => {
    verifyAccessToken.mockResolvedValue({ id: USER_ID, username: 'u', role: 'admin' });
    getEmployeeAuthById.mockResolvedValue(null);
    const res = makeRes();
    await requireAuth(makeReq('Bearer x'), res, vi.fn());
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('auth_defs_unavailable');
  });

  it('403 user_disabled with the legacy body text when access is really off', async () => {
    verifyAccessToken.mockResolvedValue({ id: USER_ID, username: 'u', role: 'admin' });
    getEmployeeAuthById.mockResolvedValue({ id: USER_ID, login: 'u', systemRole: 'admin', accessEnabled: false });
    const res = makeRes();
    await requireAuth(makeReq('Bearer x'), res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('user_disabled');
    // Old clients match on this exact text — keep it stable.
    expect(res.body.error).toBe('user disabled');
  });

  it('passes through and sets req.user when everything is fine', async () => {
    verifyAccessToken.mockResolvedValue({ id: USER_ID, username: 'jwtname', role: 'admin' });
    getEmployeeAuthById.mockResolvedValue({ id: USER_ID, login: 'реальный', systemRole: 'admin', accessEnabled: true });
    const res = makeRes();
    const next = vi.fn();
    const req = makeReq('Bearer x');
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toEqual({ id: USER_ID, username: 'реальный', role: 'admin' });
  });
});
