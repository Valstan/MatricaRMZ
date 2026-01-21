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
});
