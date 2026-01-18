export type PermissionsMap = Record<string, boolean>;

export function has(perms: PermissionsMap | null | undefined, code: string): boolean {
  return perms?.[code] === true;
}

export function deriveCaps(perms: PermissionsMap | null | undefined) {
  return {
    canViewMasterData: has(perms, 'masterdata.view'),
    canEditMasterData: has(perms, 'masterdata.edit'),
    canManageUsers: has(perms, 'admin.users.manage'),
    canChatUse: has(perms, 'chat.use'),
    canChatExport: has(perms, 'chat.export'),
    canChatAdminView: has(perms, 'chat.admin.view'),
  };
}

