import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { userPermissions, users } from '../database/schema.js';

export const PermissionCode = {
  // system / admin
  AdminUsersManage: 'admin.users.manage',

  // master-data (EAV справочники)
  MasterDataView: 'masterdata.view',
  MasterDataEdit: 'masterdata.edit',

  // engines & operations
  EnginesView: 'engines.view',
  EnginesEdit: 'engines.edit',
  OperationsView: 'operations.view',
  OperationsEdit: 'operations.edit',

  // defect act (будущий модуль)
  DefectActView: 'defect_act.view',
  DefectActEdit: 'defect_act.edit',
  DefectActPrint: 'defect_act.print',

  // reports
  ReportsView: 'reports.view',
  ReportsExport: 'reports.export',
  ReportsPrint: 'reports.print',

  // sync & updates
  SyncUse: 'sync.use',
  UpdatesUse: 'updates.use',
} as const;

export type PermissionCode = (typeof PermissionCode)[keyof typeof PermissionCode];

export function defaultPermissionsForRole(role: string): Record<string, boolean> {
  const r = String(role || '').toLowerCase();

  // admin: полный доступ
  if (r === 'admin') {
    const all: Record<string, boolean> = {};
    for (const code of Object.values(PermissionCode)) all[code] = true;
    return all;
  }

  // user: редактирование актов/справочников + sync + updates (по запросу)
  if (r === 'user') {
    return {
      [PermissionCode.MasterDataView]: true,
      [PermissionCode.MasterDataEdit]: true,

      [PermissionCode.EnginesView]: true,
      [PermissionCode.EnginesEdit]: true,

      [PermissionCode.OperationsView]: true,
      [PermissionCode.OperationsEdit]: true,

      [PermissionCode.DefectActView]: true,
      [PermissionCode.DefectActEdit]: true,
      [PermissionCode.DefectActPrint]: true,

      [PermissionCode.ReportsView]: true,
      [PermissionCode.ReportsExport]: true,
      [PermissionCode.ReportsPrint]: true,

      [PermissionCode.SyncUse]: true,
      [PermissionCode.UpdatesUse]: true,
    };
  }

  // default: только просмотр + sync
  return {
    [PermissionCode.EnginesView]: true,
    [PermissionCode.OperationsView]: true,
    [PermissionCode.ReportsView]: true,
    [PermissionCode.SyncUse]: true,
  };
}

export async function getEffectivePermissionsForUser(userId: string): Promise<Record<string, boolean>> {
  const userRows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isActive, true), isNull(users.deletedAt)))
    .limit(1);
  const u = userRows[0];
  if (!u) return {};

  const base = defaultPermissionsForRole(u.role);

  const overrides = await db
    .select({ permCode: userPermissions.permCode, allowed: userPermissions.allowed })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId))
    .limit(10_000);

  for (const o of overrides) base[o.permCode] = !!o.allowed;
  return base;
}

export async function hasPermission(userId: string, perm: string): Promise<boolean> {
  const perms = await getEffectivePermissionsForUser(userId);
  return perms[perm] === true;
}


