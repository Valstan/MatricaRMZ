import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const {
  listEmployeesAuth,
  getEmployeeAuthByLogin,
  getEmployeeAuthById,
  normalizeRole,
  dbInsert,
} = vi.hoisted(() => ({
  listEmployeesAuth: vi.fn(),
  getEmployeeAuthByLogin: vi.fn(),
  getEmployeeAuthById: vi.fn(),
  normalizeRole: vi.fn((login: string, role: string | null | undefined) => String(role ?? 'user').toLowerCase()),
  dbInsert: vi.fn(() => ({
    values: vi.fn().mockResolvedValue({}),
    onConflictDoNothing: vi.fn().mockResolvedValue({}),
    onConflictDoUpdate: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../auth/middleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'u-admin', username: 'admin', role: 'admin' };
    next();
  },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/employeeAuthService.js', () => ({
  listEmployeesAuth,
  getEmployeeAuthByLogin,
  getEmployeeAuthById,
  normalizeRole,
  ensureEmployeeAuthDefs: vi.fn().mockResolvedValue({ ok: true, employeeTypeId: 'type', defs: {} }),
  getEmployeeTypeId: vi.fn().mockResolvedValue('type'),
  getEmployeeProfileById: vi.fn().mockResolvedValue(null),
  isLoginTaken: vi.fn().mockResolvedValue(false),
  isSuperadminLogin: vi.fn().mockReturnValue(false),
  setEmployeeAuth: vi.fn().mockResolvedValue({ ok: true }),
  setEmployeeFullName: vi.fn().mockResolvedValue({ ok: true }),
  setEmployeeProfile: vi.fn().mockResolvedValue({ ok: true }),
  getSuperadminUserId: vi.fn().mockResolvedValue(null),
}));

vi.mock('../auth/password.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('hash'),
  verifyPassword: vi.fn().mockResolvedValue(true),
}));

vi.mock('../auth/jwt.js', () => ({
  signAccessToken: vi.fn().mockResolvedValue('access-token'),
}));

vi.mock('../auth/refresh.js', () => ({
  generateRefreshToken: vi.fn().mockReturnValue('refresh-token'),
  hashRefreshToken: vi.fn().mockReturnValue('refresh-token-hash'),
  getRefreshTtlDays: vi.fn().mockReturnValue(7),
}));

vi.mock('../auth/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('../auth/permissions.js')>('../auth/permissions.js');
  return {
    ...actual,
    getEffectivePermissionsForUser: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('../database/db.js', () => ({
  db: {
    insert: dbInsert,
    select: vi.fn(),
    update: vi.fn(),
  },
}));

import { createApp } from '../app.js';

describe('backend routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /health returns ok', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /updates/status returns ok', async () => {
    const app = createApp();
    const res = await request(app).get('/updates/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /admin/users returns users list', async () => {
    listEmployeesAuth.mockResolvedValueOnce({
      ok: true,
      rows: [
        { id: 'u1', login: 'admin', passwordHash: 'hash', systemRole: 'admin', accessEnabled: true, fullName: 'Admin', chatDisplayName: '' },
      ],
    });
    const app = createApp();
    const res = await request(app).get('/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.users?.length).toBe(1);
  });

  it('POST /client/watchdog/report accepts a failure report', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/client/watchdog/report')
      .send({ clientId: 'PC-test-123', kind: 'failed', version: '2026.1.1', detail: 'app still missing after install' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /client/watchdog/report rejects invalid kind', async () => {
    const app = createApp();
    const res = await request(app).post('/client/watchdog/report').send({ clientId: 'PC-test-123', kind: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /auth/login returns token payload', async () => {
    getEmployeeAuthByLogin.mockResolvedValueOnce({
      id: 'u1',
      login: 'user',
      passwordHash: 'hash',
      systemRole: 'admin',
      accessEnabled: true,
      fullName: 'User',
      chatDisplayName: '',
    });
    getEmployeeAuthById.mockResolvedValueOnce({
      id: 'u1',
      login: 'user',
      passwordHash: 'hash',
      systemRole: 'admin',
      accessEnabled: true,
      fullName: 'User',
    });
    const app = createApp();
    const res = await request(app).post('/auth/login').send({ username: 'user', password: 'pass' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accessToken).toBe('access-token');
  });

  it('GET /ledger/state/query rejects catastrophic-backtracking regex (ReDoS guard)', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/ledger/state/query')
      .query({ table: 'entities', regex_field: 'name', regex: '(a+)+' });
    expect(res.status).toBe(400);
  });

  it('GET /ledger/state/query rejects over-long regex (ReDoS guard)', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/ledger/state/query')
      .query({ table: 'entities', regex_field: 'name', regex: 'a'.repeat(201) });
    expect(res.status).toBe(400);
  });

  it('GET /auth/login-suggest returns [] for a query shorter than 2 chars', async () => {
    const app = createApp();
    const res = await request(app).get('/auth/login-suggest').query({ q: 'a' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, rows: [] });
  });

  it('GET /auth/login-suggest prefix-matches login/name, excludes pending/disabled, returns only login+fullName', async () => {
    listEmployeesAuth.mockResolvedValueOnce({
      ok: true,
      rows: [
        { login: 'ivanov', fullName: 'Иванов Иван', systemRole: 'master', accessEnabled: true },
        { login: 'petrov', fullName: 'Петров Пётр', systemRole: 'admin', accessEnabled: true },
        { login: 'sidorov', fullName: 'Иволгин Сидор', systemRole: 'pending', accessEnabled: true },
        { login: 'disabled1', fullName: 'Ивлев Олег', systemRole: 'master', accessEnabled: false },
      ],
    });
    const app = createApp();
    const res = await request(app).get('/auth/login-suggest').query({ q: 'ив' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const logins = res.body.rows.map((r: { login: string }) => r.login);
    expect(logins).toContain('ivanov'); // fullName token «Иванов» starts with «ив»
    expect(logins).not.toContain('petrov'); // no «ив» prefix
    expect(logins).not.toContain('sidorov'); // pending
    expect(logins).not.toContain('disabled1'); // accessEnabled=false
    expect(Object.keys(res.body.rows[0]).sort()).toEqual(['fullName', 'login']); // no role/position leaked
  });
});
