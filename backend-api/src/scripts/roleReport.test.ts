import { describe, expect, it, vi } from 'vitest';

// roleReport pulls in the pg-backed db transitively (via employeeAuthService and
// its own `pool` import); stub it so importing the module does not construct a
// real connection pool. The function under test (buildRoleReport) is pure and
// only calls normalizeRole (also pure). The CLI main() is entry-guarded.
vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));

const { buildRoleReport } = await import('./roleReport.js');
const { normalizeRole } = await import('../services/employeeAuthService.js');
import type { EmployeeAuthLike } from './roleReport.js';

function row(p: Partial<EmployeeAuthLike> & { login: string }): EmployeeAuthLike {
  return { id: p.id ?? `id-${p.login}`, login: p.login, fullName: p.fullName ?? null, systemRole: p.systemRole ?? 'user', accessEnabled: p.accessEnabled ?? true };
}

describe('buildRoleReport — H7 count-by-role', () => {
  it('counts per normalized role, split active/disabled', () => {
    const r = buildRoleReport([
      row({ login: 'a', systemRole: 'admin' }),
      row({ login: 'b', systemRole: 'admin', accessEnabled: false }),
      row({ login: 'c', systemRole: 'master' }),
      row({ login: 'd', systemRole: 'pending' }),
      row({ login: 'e', systemRole: 'employee' }),
    ]);
    expect(r.totalEmployees).toBe(5);
    const by = Object.fromEntries(r.byRole.map((x) => [x.role, x]));
    expect(by['admin']).toMatchObject({ active: 1, disabled: 1, total: 2 });
    expect(by['master']).toMatchObject({ active: 1, disabled: 0, total: 1 });
    expect(by['pending']).toMatchObject({ active: 1, total: 1 });
    expect(by['employee']).toMatchObject({ active: 1, total: 1 });
  });

  it('places explicit `user` into the legacy-user bucket and the live worklist', () => {
    const r = buildRoleReport([
      row({ login: 'u1', systemRole: 'user', fullName: 'Иванов И.И.' }),
      row({ login: 'u2', systemRole: 'user', accessEnabled: false }),
    ]);
    expect(r.userBucket.activeTotal).toBe(1);
    expect(r.userBucket.disabledTotal).toBe(1);
    const legacy = r.userBucket.breakdown.find((b) => b.kind === 'legacy-user');
    expect(legacy).toMatchObject({ rawValue: 'user', active: 1, disabled: 1, total: 2 });
    expect(r.userBucket.worklist).toHaveLength(1);
    expect(r.userBucket.worklist[0]).toMatchObject({ login: 'u1', fullName: 'Иванов И.И.', rawRole: 'user', kind: 'legacy-user' });
  });

  it('flags an UNKNOWN raw role (fail-closed → employee since H7 step в)', () => {
    const r = buildRoleReport([
      row({ login: 'typo', systemRole: 'sabotage' }),
      row({ login: 'typo2', systemRole: 'Мастер' }), // cyrillic — not a known key
    ]);
    // both fail-close to `employee` but stay in the anomaly bucket
    expect(r.byRole.find((x) => x.role === 'employee')).toMatchObject({ active: 2, total: 2 });
    expect(r.byRole.find((x) => x.role === 'user')).toBeUndefined();
    expect(r.userBucket.activeTotal).toBe(2);
    expect(r.userBucket.unknownRawRoles).toEqual(['sabotage', 'мастер']);
    const unknownBuckets = r.userBucket.breakdown.filter((b) => b.kind === 'unknown');
    expect(unknownBuckets).toHaveLength(2);
    // unknown entries sort before legacy/empty
    expect(r.userBucket.breakdown[0]?.kind).toBe('unknown');
    expect(r.userBucket.worklist.every((w) => w.kind === 'unknown')).toBe(true);
  });

  it('treats an empty raw role as (empty), distinct from explicit user', () => {
    const r = buildRoleReport([row({ login: 'noattr', systemRole: '' })]);
    expect(r.userBucket.activeTotal).toBe(1);
    const empty = r.userBucket.breakdown.find((b) => b.kind === 'empty');
    expect(empty).toMatchObject({ rawValue: '(empty)', active: 1 });
    expect(r.userBucket.unknownRawRoles).toEqual([]);
    expect(r.userBucket.worklist[0]?.rawRole).toBe('(empty)');
  });

  it('never puts the superadmin login into the user bucket, even with a `user` raw role', () => {
    const r = buildRoleReport([row({ login: 'valstan', systemRole: 'user' })]);
    expect(r.userBucket.activeTotal).toBe(0);
    expect(r.byRole.find((x) => x.role === 'superadmin')).toMatchObject({ active: 1, total: 1 });
  });

  it('keeps operator roles out of the user bucket', () => {
    const r = buildRoleReport([
      row({ login: 'm', systemRole: 'master' }),
      row({ login: 'e', systemRole: 'engineer' }),
      row({ login: 't', systemRole: 'technolog' }),
      row({ login: 's', systemRole: 'supply' }),
      row({ login: 'k', systemRole: 'timekeeper' }),
      row({ login: 'v', systemRole: 'viewer' }),
    ]);
    expect(r.userBucket.activeTotal).toBe(0);
    expect(r.userBucket.worklist).toHaveLength(0);
  });

  it('keeps explicit `employee` rows out of the anomaly bucket', () => {
    const r = buildRoleReport([row({ login: 'e', systemRole: 'employee' })]);
    expect(r.userBucket.activeTotal).toBe(0);
    expect(r.userBucket.worklist).toHaveLength(0);
  });

  it('caps the worklist without capping the counts', () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ login: `u${i}`, systemRole: 'user' }));
    const r = buildRoleReport(many, 3);
    expect(r.userBucket.activeTotal).toBe(10); // count not truncated
    expect(r.userBucket.worklist).toHaveLength(3); // worklist capped
  });
});

describe('normalizeRole — H7 step (в) fail-closed default', () => {
  it('resolves known roles as before', () => {
    expect(normalizeRole('x', 'admin')).toBe('admin');
    expect(normalizeRole('x', 'master')).toBe('master');
    expect(normalizeRole('x', 'pending')).toBe('pending');
    expect(normalizeRole('x', 'employee')).toBe('employee');
    expect(normalizeRole('x', 'user')).toBe('user'); // deliberate legacy tier
  });

  it('fail-closes unknown/typo/empty roles to employee (no access)', () => {
    expect(normalizeRole('x', 'sabotage')).toBe('employee');
    expect(normalizeRole('x', 'Мастер')).toBe('employee');
    expect(normalizeRole('x', 'merged')).toBe('employee');
    expect(normalizeRole('x', '')).toBe('employee');
    expect(normalizeRole('x', null)).toBe('employee');
    expect(normalizeRole('x', undefined)).toBe('employee');
  });

  it('superadmin login always wins regardless of stored role', () => {
    expect(normalizeRole('valstan', 'sabotage')).toBe('superadmin');
  });
});
