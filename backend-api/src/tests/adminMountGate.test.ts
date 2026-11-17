import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * Гейт `/admin` не должен закрывать соседние разделы (жалоба владельца 17.11.2026).
 *
 * Роутеры админки смонтированы на общем префиксе `/admin`:
 *   app.use('/admin', adminUsersRouter);        // право admin.users.manage
 *   app.use('/admin', adminClientsRouter);      // право clients.manage
 *   app.use('/admin/masterdata', adminMasterdataRouter);
 *
 * `requirePermission` без пути срабатывает на ЛЮБОЙ запрос, попавший в роутер, —
 * поэтому кладовщик с правом `employees.dedupe` получал 403 «forbidden» в диалоге
 * дублей: `/admin/masterdata` перехватывался гейтом `admin.users.manage` ещё до
 * своего роутера. Журнал `server.authz.denied` на проде показал ровно это:
 * «кладовщик (роль storekeeper) — нет права admin.users.manage на
 * /admin/masterdata/employees/dedupe/analyze».
 *
 * Тест держит ТРИ вещи: чужой раздел не закрывается чужим правом, свой раздел
 * остаётся под своим гейтом, а отказ без права на дубли говорит СВОИМ текстом.
 */

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn() }));

function chainable(): unknown {
  const target = () => undefined;
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          Promise.resolve([]).then(resolve, reject);
      }
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

vi.mock('../database/db.js', () => ({
  db: {
    select: () => chainable(),
    update: () => chainable(),
    insert: () => chainable(),
    transaction: vi.fn(),
  },
}));

vi.mock('../auth/jwt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/jwt.js')>();
  return {
    ...actual,
    verifyAccessToken: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111', username: 'storekeeper1' })),
  };
});

vi.mock('../services/employeeAuthService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/employeeAuthService.js')>();
  return {
    ...actual,
    getEmployeeAuthById: vi.fn(async () => ({ accessEnabled: true, login: 'storekeeper1', systemRole: 'storekeeper' })),
    normalizeRole: vi.fn(() => 'storekeeper'),
  };
});

vi.mock('../auth/permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/permissions.js')>();
  return { ...actual, hasPermission, getEffectivePermissionsForUser: vi.fn(async () => ({})) };
});

vi.mock('../services/authzDenialLog.js', () => ({
  recordRestAuthzDenial: vi.fn(),
  recordLedgerAuthzDenial: vi.fn(),
  recordLedgerReferenceDenial: vi.fn(),
}));

vi.mock('../services/employeeDedupeService.js', () => ({
  analyzeEmployeeDuplicates: vi.fn(async () => ({ ok: true, totalEmployees: 0, groups: [] })),
  findEmployeeDuplicates: vi.fn(async () => ({ ok: true, matches: [] })),
  findEmployeeDuplicatesByKey: vi.fn(async () => ({ ok: true, relation: 'different', matches: [] })),
  mergeEmployeeGroup: vi.fn(async () => ({ ok: true, report: {} })),
  recordEmployeeDuplicateOverride: vi.fn(async () => ({ ok: true })),
  removeDuplicateEmployee: vi.fn(async () => ({ ok: true, survivorId: 'u-1', conflicts: [] })),
}));

import { createApp } from '../app.js';

const AUTH = { Authorization: 'Bearer test-token' };

describe('admin mount gates — раздел не закрывается чужим правом', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('кладовщик с employees.dedupe доходит до разбора дублей', async () => {
    hasPermission.mockImplementation(async (_id: string, perm: string) => perm === 'employees.dedupe');
    const app = createApp();
    const res = await request(app).get('/admin/masterdata/employees/dedupe/analyze').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('раздел пользователей остаётся под admin.users.manage', async () => {
    hasPermission.mockImplementation(async (_id: string, perm: string) => perm === 'employees.dedupe');
    const app = createApp();
    const res = await request(app).get('/admin/users').set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('раздел клиентов остаётся под clients.manage', async () => {
    hasPermission.mockImplementation(async (_id: string, perm: string) => perm === 'employees.dedupe');
    const app = createApp();
    const res = await request(app).get('/admin/clients').set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('без права на дубли разбор дублей отклоняется СВОИМ текстом, а не «forbidden»', async () => {
    hasPermission.mockImplementation(async () => false);
    const app = createApp();
    const res = await request(app).get('/admin/masterdata/employees/dedupe/analyze').set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('нет права на обработку дублей сотрудников');
  });

  it('админские справочники по-прежнему закрыты для кладовщика', async () => {
    hasPermission.mockImplementation(async (_id: string, perm: string) => perm === 'employees.dedupe');
    const app = createApp();
    const res = await request(app).get('/admin/masterdata/entity-types').set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('только для админов');
  });
});
