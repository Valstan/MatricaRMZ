import { and, eq, gt, isNull, lt } from 'drizzle-orm';

import { db } from '../database/db.js';
import { permissionDelegations, userPermissions, users } from '../database/schema.js';

export const PermissionCode = {
  // system / admin
  AdminUsersManage: 'admin.users.manage',

  // master-data (EAV справочники)
  MasterDataView: 'masterdata.view',
  MasterDataEdit: 'masterdata.edit',

  // supply requests (заявки в снабжение)
  SupplyRequestsView: 'supply_requests.view',
  SupplyRequestsCreate: 'supply_requests.create',
  SupplyRequestsEdit: 'supply_requests.edit',
  SupplyRequestsSign: 'supply_requests.sign',
  SupplyRequestsDirectorApprove: 'supply_requests.director_approve',
  SupplyRequestsAccept: 'supply_requests.accept',
  SupplyRequestsFulfill: 'supply_requests.fulfill',
  SupplyRequestsPrint: 'supply_requests.print',

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

  // files
  FilesView: 'files.view',
  FilesUpload: 'files.upload',
  FilesDelete: 'files.delete',

  // parts (детали)
  PartsView: 'parts.view',
  PartsCreate: 'parts.create',
  PartsEdit: 'parts.edit',
  PartsDelete: 'parts.delete',
  PartsFilesUpload: 'parts.files.upload',
  PartsFilesDelete: 'parts.files.delete',
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

      [PermissionCode.SupplyRequestsView]: true,
      [PermissionCode.SupplyRequestsCreate]: true,
      [PermissionCode.SupplyRequestsEdit]: true,
      [PermissionCode.SupplyRequestsSign]: true,
      [PermissionCode.SupplyRequestsPrint]: true,

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

      // files
      [PermissionCode.FilesView]: true,
      [PermissionCode.FilesUpload]: true,
      [PermissionCode.FilesDelete]: true,

      // parts
      [PermissionCode.PartsView]: true,
      [PermissionCode.PartsCreate]: true,
      [PermissionCode.PartsEdit]: true,
      [PermissionCode.PartsDelete]: true,
      [PermissionCode.PartsFilesUpload]: true,
      [PermissionCode.PartsFilesDelete]: true,
    };
  }

  // default: только просмотр + sync
  return {
    [PermissionCode.SupplyRequestsView]: true,
    [PermissionCode.EnginesView]: true,
    [PermissionCode.OperationsView]: true,
    [PermissionCode.ReportsView]: true,
    [PermissionCode.SyncUse]: true,

    // files (просмотр/скачивание по ссылке)
    [PermissionCode.FilesView]: true,

    // parts (только просмотр)
    [PermissionCode.PartsView]: true,
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

  return base;
}

export async function hasPermission(userId: string, perm: string): Promise<boolean> {
  const perms = await getEffectivePermissionsForUser(userId);
  return perms[perm] === true;
}


