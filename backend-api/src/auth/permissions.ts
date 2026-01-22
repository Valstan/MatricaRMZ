import { and, eq, gt, isNull, lt } from 'drizzle-orm';

import { PermissionCode as SharedPermissionCode, type PermissionCode as SharedPermissionCodeType } from '@matricarmz/shared';
import { db } from '../database/db.js';
import { permissionDelegations, userPermissions } from '../database/schema.js';
import { getEmployeeAuthById, isSuperadminLogin, normalizeRole } from '../services/employeeAuthService.js';

export const PermissionCode = SharedPermissionCode;
export type PermissionCode = SharedPermissionCodeType;

export function defaultPermissionsForRole(role: string): Record<string, boolean> {
  const r = String(role || '').toLowerCase();

  // superadmin: полный доступ
  if (r === 'superadmin') {
    const all: Record<string, boolean> = {};
    for (const code of Object.values(PermissionCode)) all[code] = true;
    return all;
  }

  // admin: полный доступ
  if (r === 'admin') {
    const all: Record<string, boolean> = {};
    for (const code of Object.values(PermissionCode)) all[code] = true;
    return all;
  }

  // employee: no access to the app
  if (r === 'employee') {
    return {};
  }

  // user: по новой политике — все права включены по умолчанию,
  // а админ уже отключает лишнее. Исключение: управление пользователями
  // доступно только role=admin.
  if (r === 'user') {
    const all: Record<string, boolean> = {};
    for (const code of Object.values(PermissionCode)) all[code] = true;
    all[PermissionCode.AdminUsersManage] = false;
    all[PermissionCode.ClientsManage] = false;
    return all;
  }

  // pending: минимальный доступ — только чат с админом
  if (r === 'pending') {
    return {
      [PermissionCode.ChatUse]: true,
      [PermissionCode.SyncUse]: true,
    };
  }

  // default: только просмотр + sync
  return {
    [PermissionCode.SupplyRequestsView]: true,
    [PermissionCode.EnginesView]: true,
    [PermissionCode.OperationsView]: true,
    [PermissionCode.ReportsView]: true,
    [PermissionCode.EmployeesView]: true,
    [PermissionCode.SyncUse]: true,

    // files (просмотр/скачивание по ссылке)
    [PermissionCode.FilesView]: true,

    // parts (только просмотр)
    [PermissionCode.PartsView]: true,

    // chat (только пользование)
    [PermissionCode.ChatUse]: true,
  };
}

export async function getEffectivePermissionsForUser(userId: string): Promise<Record<string, boolean>> {
  const u = await getEmployeeAuthById(userId);
  if (!u || !u.accessEnabled) return {};

  const role = normalizeRole(u.login, u.systemRole);
  if (isSuperadminLogin(u.login)) return defaultPermissionsForRole('superadmin');
  const base = defaultPermissionsForRole(role);

  const overrides = await db
    .select({ permCode: userPermissions.permCode, allowed: userPermissions.allowed })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId))
    .limit(10_000);

  for (const o of overrides) base[o.permCode] = !!o.allowed;

  // Временные делегирования: если есть активное делегирование permCode -> userId, считаем permCode=true.
  const now = Date.now();
  const delegations = await db
    .select({ permCode: permissionDelegations.permCode })
    .from(permissionDelegations)
    .where(
      and(
        eq(permissionDelegations.toUserId, userId),
        lt(permissionDelegations.startsAt, now + 1),
        gt(permissionDelegations.endsAt, now),
        isNull(permissionDelegations.revokedAt),
      ),
    )
    .limit(10_000);
  for (const d of delegations) base[d.permCode] = true;

  // Политика безопасности: `admin.users.manage` доступен только admin/superadmin.
  if (role !== 'admin' && role !== 'superadmin') base[PermissionCode.AdminUsersManage] = false;
  if (role !== 'admin' && role !== 'superadmin') base[PermissionCode.ClientsManage] = false;

  return base;
}

export async function hasPermission(userId: string, perm: string): Promise<boolean> {
  const perms = await getEffectivePermissionsForUser(userId);
  return perms[perm] === true;
}


