export type PermissionsMap = Record<string, boolean>;

export function has(perms: PermissionsMap | null | undefined, code: string): boolean {
  return perms?.[code] === true;
}

export type UiCaps = {
  canViewEngines: boolean;
  canEditEngines: boolean;
  canViewOperations: boolean;
  canEditOperations: boolean;
  canUseSync: boolean;
  canViewReports: boolean;
  canExportReports: boolean;
  canPrintReports: boolean;
  canViewMasterData: boolean;
  canEditMasterData: boolean;
  canManageUsers: boolean;
  canViewAudit: boolean;
};

export function deriveUiCaps(perms: PermissionsMap | null | undefined): UiCaps {
  const canManageUsers = has(perms, 'admin.users.manage');
  const canViewMasterData = has(perms, 'masterdata.view');
  const canEditMasterData = has(perms, 'masterdata.edit');

  const canViewReports = has(perms, 'reports.view');
  const canExportReports = has(perms, 'reports.export');
  const canPrintReports = has(perms, 'reports.print');

  const canViewEngines = has(perms, 'engines.view');
  const canEditEngines = has(perms, 'engines.edit');

  const canViewOperations = has(perms, 'operations.view');
  const canEditOperations = has(perms, 'operations.edit');

  const canUseSync = has(perms, 'sync.use');

  // По плану: вкладка "Журнал" = админская диагностика (без новых permissions).
  const canViewAudit = canManageUsers;

  return {
    canViewEngines,
    canEditEngines,
    canViewOperations,
    canEditOperations,
    canUseSync,
    canViewReports,
    canExportReports,
    canPrintReports,
    canViewMasterData,
    canEditMasterData,
    canManageUsers,
    canViewAudit,
  };
}


