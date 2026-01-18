import { and, eq, gt, isNull, lt } from 'drizzle-orm';

import { db } from '../database/db.js';
import { permissionDelegations, userPermissions } from '../database/schema.js';
import { getEmployeeAuthById, isSuperadminLogin, normalizeRole } from '../services/employeeAuthService.js';

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

  // backups
  BackupsView: 'backups.view',
  BackupsRun: 'backups.run',

  // parts (детали)
  PartsView: 'parts.view',
  PartsCreate: 'parts.create',
  PartsEdit: 'parts.edit',
  PartsDelete: 'parts.delete',
  PartsFilesUpload: 'parts.files.upload',
  PartsFilesDelete: 'parts.files.delete',

  // chat
  ChatUse: 'chat.use',
  ChatExport: 'chat.export',
  ChatAdminView: 'chat.admin.view',
} as const;

export type PermissionCode = (typeof PermissionCode)[keyof typeof PermissionCode];

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

  // user: по новой политике — все права включены по умолчанию,
  // а админ уже отключает лишнее. Исключение: управление пользователями
  // доступно только role=admin.
  if (r === 'user') {
    const all: Record<string, boolean> = {};
    for (const code of Object.values(PermissionCode)) all[code] = true;
    all[PermissionCode.AdminUsersManage] = false;
    return all;
  }

  // pending: минимальный доступ — только чат с админом
  if (r === 'pending') {
    return {
      [PermissionCode.ChatUse]: true,
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

  return base;
}

export async function hasPermission(userId: string, perm: string): Promise<boolean> {
  const perms = await getEffectivePermissionsForUser(userId);
  return perms[perm] === true;
}


