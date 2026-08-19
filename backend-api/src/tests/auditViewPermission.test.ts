import { describe, expect, it, vi } from 'vitest';

// «Журнал действий» выдаётся поимённо (решение владельца 2026-08-19: супер-админ и
// Сапегин Николай, пока больше никто). Значит право НЕ должно приезжать вместе с
// ролью админа — иначе журнал молча открылся бы всем администраторам.

vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));

const { defaultPermissionsForRole } = await import('../auth/permissions.js');
const { PermissionCode } = await import('@matricarmz/shared');

describe('audit.view — выдаваемое право, не роль', () => {
  it('есть у супер-админа по умолчанию', () => {
    expect(defaultPermissionsForRole('superadmin')[PermissionCode.AuditView]).toBe(true);
  });

  it('НЕ приезжает вместе с ролью admin', () => {
    expect(defaultPermissionsForRole('admin')[PermissionCode.AuditView]).toBe(false);
  });

  it('НЕ приезжает операторским ролям и легаси-user', () => {
    for (const role of ['user', 'master', 'technolog', 'supply', 'timekeeper', 'viewer']) {
      expect(defaultPermissionsForRole(role)[PermissionCode.AuditView] ?? false).toBe(false);
    }
  });

  it('роли без доступа к программе прав не получают вовсе', () => {
    expect(defaultPermissionsForRole('employee')).toEqual({});
    expect(defaultPermissionsForRole('pending')).toEqual({});
  });

  it('admin сохраняет свои админские права — сузили ровно одно', () => {
    const admin = defaultPermissionsForRole('admin');
    expect(admin[PermissionCode.AdminUsersManage]).toBe(true);
    expect(admin[PermissionCode.ChatAdminView]).toBe(true);
  });
});
