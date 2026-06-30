import { and, eq, gt, isNull, lt } from 'drizzle-orm';

import { PermissionCode as SharedPermissionCode, type PermissionCode as SharedPermissionCodeType, operatorRolePermissions } from '@matricarmz/shared';
import { db } from '../database/db.js';
import { permissionDelegations, userPermissions } from '../database/schema.js';
import { getEmployeeAuthById, isSuperadminLogin, normalizeRole } from '../services/employeeAuthService.js';

export const PermissionCode = SharedPermissionCode;
export type PermissionCode = SharedPermissionCodeType;

export function defaultPermissionsForRole(role: string): Record<string, boolean> {
  const r = String(role || '').toLowerCase();

  // employee: no access to the app
  if (r === 'employee') {
    return {};
  }

  // pending: self-registered, NOT yet approved by an admin → no access until a
  // real role is assigned. Previously fell through to the catch-all below and
  // received every non-admin permission (incl. sync.use / *.view), so anyone who
  // could POST /auth/register obtained a token that pulled the entire dataset via
  // /ledger/state/changes. (security-hardening-2026-06 C1)
  if (r === 'pending') {
    return {};
  }

  // Operator work-area roles (RBAC #474): view base + scoped edit footprint.
  const operator = operatorRolePermissions(r);
  if (operator) return operator;

  // superadmin / admin / user (legacy) / pending — полный доступ (минус admin-only).
  const all: Record<string, boolean> = {};
  for (const code of Object.values(PermissionCode)) all[code] = true;
  if (r !== 'admin' && r !== 'superadmin') {
    all[PermissionCode.AdminUsersManage] = false;
    all[PermissionCode.ClientsManage] = false;
    all[PermissionCode.ChatAdminView] = false;
    all[PermissionCode.ChatExport] = false;
    all[PermissionCode.WorkshopsManage] = false;
    all[PermissionCode.WorkshopRepairTemplatesEdit] = false;
    all[PermissionCode.WarehouseLocationsManage] = false;
    all[PermissionCode.MovementsRevert] = false;
  }
  return all;
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

  // Политика безопасности: admin-only коды доступны только admin/superadmin.
  if (role !== 'admin' && role !== 'superadmin') base[PermissionCode.AdminUsersManage] = false;
  if (role !== 'admin' && role !== 'superadmin') base[PermissionCode.ClientsManage] = false;
  if (role !== 'admin' && role !== 'superadmin') {
    base[PermissionCode.ChatAdminView] = false;
    base[PermissionCode.ChatExport] = false;
    base[PermissionCode.WorkshopsManage] = false;
    base[PermissionCode.WorkshopRepairTemplatesEdit] = false;
    base[PermissionCode.WarehouseLocationsManage] = false;
    base[PermissionCode.MovementsRevert] = false;
  } else {
    base[PermissionCode.ChatAdminView] = true;
    base[PermissionCode.ChatExport] = true;
  }

  return base;
}

export async function hasPermission(userId: string, perm: string): Promise<boolean> {
  const perms = await getEffectivePermissionsForUser(userId);
  return perms[perm] === true;
}


