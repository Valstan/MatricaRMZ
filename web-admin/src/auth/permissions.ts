export type PermissionsMap = Record<string, boolean>;

export function has(perms: PermissionsMap | null | undefined, code: string): boolean {
  return perms?.[code] === true;
}

export function deriveCaps(perms: PermissionsMap | null | undefined) {
  return {
    canViewMasterData: has(perms, 'masterdata.view'),
    canEditMasterData: has(perms, 'masterdata.edit'),
    canViewEngines: has(perms, 'engines.view'),
    canEditEngines: has(perms, 'engines.edit'),
    canViewOperations: has(perms, 'operations.view'),
    canEditOperations: has(perms, 'operations.edit'),
    canViewReports: has(perms, 'reports.view'),
    canExportReports: has(perms, 'reports.export'),
    canManageUsers: has(perms, 'admin.users.manage'),
    canManageClients: has(perms, 'clients.manage'),
    canChatUse: has(perms, 'chat.use'),
    canChatExport: has(perms, 'chat.export'),
    canChatAdminView: has(perms, 'chat.admin.view'),
    canViewFiles: has(perms, 'files.view'),
    canUploadFiles: has(perms, 'files.upload'),
  };
}

