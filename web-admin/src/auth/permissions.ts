export type PermissionsMap = Record<string, boolean>;

export function has(perms: PermissionsMap | null | undefined, code: string): boolean {
  return perms?.[code] === true;
}

export function deriveCaps(perms: PermissionsMap | null | undefined, role?: string | null) {
  const isSuperadmin = String(role ?? '').trim().toLowerCase() === 'superadmin';
  return {
    canViewMasterData: has(perms, 'masterdata.view'),
    canEditMasterData: has(perms, 'masterdata.edit'),
    canViewEngines: has(perms, 'engines.view'),
    canEditEngines: has(perms, 'engines.edit'),
    canViewOperations: has(perms, 'operations.view'),
    canEditOperations: has(perms, 'operations.edit'),
    canViewReports: has(perms, 'reports.view'),
    canExportReports: has(perms, 'reports.export'),
    // Журнал: серверный роут требует audit.view и пропускает суперадмина всегда
    // (backend routes/adminAudit.ts). Здесь стояло `updates.use` — право «Доступ к
    // модулю Изменения», входящее в операторский набор: вкладка показывалась всем,
    // а все три её запроса отвечали 403. Предикат повторяет серверный дословно.
    canViewAudit: isSuperadmin || has(perms, 'audit.view'),
    canManageUsers: has(perms, 'admin.users.manage'),
    canManageClients: has(perms, 'clients.manage'),
    canChatUse: has(perms, 'chat.use'),
    canChatExport: has(perms, 'chat.export'),
    canChatAdminView: has(perms, 'chat.admin.view'),
    canViewFiles: has(perms, 'files.view'),
    canUploadFiles: has(perms, 'files.upload'),
  };
}

