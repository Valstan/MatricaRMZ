import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, requirePermOrThrow, viewModeWriteError } from '../ipcContext.js';

import {
  deleteAttributeDef,
  deleteEntityType,
  getAttributeDefDeleteInfo,
  getEntityTypeDeleteInfo,
  listAttributeDefsByEntityType,
  listEntityTypes,
  upsertAttributeDef,
  upsertEntityType,
} from '../../services/adminService.js';
import {
  createEntity,
  detachIncomingLinksAndSoftDeleteEntity,
  getEntityDetails,
  getIncomingLinksForEntity,
  listEntitiesByType,
  setEntityAttribute,
  softDeleteEntity,
} from '../../services/entityService.js';
import {
  adminCreateDelegation,
  adminCreateUser,
  adminGetUserPermissions,
  adminListUserDelegations,
  adminListUsers,
  adminPendingApprove,
  adminRevokeDelegation,
  adminSetUserPermissions,
  adminUpdateUser,
} from '../../services/adminUsersService.js';
import { adminResyncAllMasterdata, adminResyncEntityType } from '../../services/adminMasterdataRemoteService.js';

export function registerAdminIpc(ctx: IpcContext) {
  // Master-data: EntityTypes/AttributeDefs/Entities
  ipcMain.handle('admin:entityTypes:list', async () => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return [];
    return listEntityTypes(ctx.dataDb());
  });
  ipcMain.handle('admin:entityTypes:upsert', async (_e, args: { id?: string; code: string; name: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate;
    return upsertEntityType(ctx.dataDb(), args);
  });
  ipcMain.handle('admin:entityTypes:deleteInfo', async (_e, entityTypeId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return getEntityTypeDeleteInfo(ctx.dataDb(), entityTypeId);
  });
  ipcMain.handle(
    'admin:entityTypes:delete',
    async (_e, args: { entityTypeId: string; deleteEntities: boolean; deleteDefs: boolean }) => {
      if (isViewMode(ctx)) return viewModeWriteError() as any;
      const gate = await requirePermOrResult(ctx, 'masterdata.edit');
      if (!gate.ok) return gate as any;
      return deleteEntityType(ctx.dataDb(), args.entityTypeId, { deleteEntities: !!args.deleteEntities, deleteDefs: !!args.deleteDefs });
    },
  );
  ipcMain.handle('admin:entityTypes:resyncFromServer', async (_e, entityTypeId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const resync = await adminResyncEntityType(ctx.sysDb, ctx.mgr.getApiBaseUrl(), entityTypeId);
    if (!resync.ok) return resync;
    const sync = await ctx.mgr.runOnce().catch((e) => ({ ok: false as const, error: String(e) }));
    return { ok: true as const, resync, sync };
  });
  ipcMain.handle('admin:entityTypes:resyncAllFromServer', async () => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as any;
    const resync = await adminResyncAllMasterdata(ctx.sysDb, ctx.mgr.getApiBaseUrl());
    if (!resync.ok) return resync;
    const sync = await ctx.mgr.runOnce().catch((e) => ({ ok: false as const, error: String(e) }));
    return { ok: true as const, resync, sync };
  });

  ipcMain.handle('admin:attributeDefs:listByEntityType', async (_e, entityTypeId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return [];
    return listAttributeDefsByEntityType(ctx.dataDb(), entityTypeId);
  });
  ipcMain.handle(
    'admin:attributeDefs:upsert',
    async (
      _e,
      args: {
        id?: string;
        entityTypeId: string;
        code: string;
        name: string;
        dataType: string;
        isRequired?: boolean;
        sortOrder?: number;
        metaJson?: string | null;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'masterdata.edit');
      if (!gate.ok) return gate;
      return upsertAttributeDef(ctx.dataDb(), args);
    },
  );
  ipcMain.handle('admin:attributeDefs:deleteInfo', async (_e, attributeDefId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return getAttributeDefDeleteInfo(ctx.dataDb(), attributeDefId);
  });
  ipcMain.handle(
    'admin:attributeDefs:delete',
    async (_e, args: { attributeDefId: string; deleteValues: boolean }) => {
      if (isViewMode(ctx)) return viewModeWriteError() as any;
      const gate = await requirePermOrResult(ctx, 'masterdata.edit');
      if (!gate.ok) return gate as any;
      return deleteAttributeDef(ctx.dataDb(), args.attributeDefId, { deleteValues: !!args.deleteValues });
    },
  );

  ipcMain.handle('admin:entities:listByEntityType', async (_e, entityTypeId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return [];
    return listEntitiesByType(ctx.dataDb(), entityTypeId);
  });
  ipcMain.handle('admin:entities:create', async (_e, entityTypeId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return createEntity(ctx.dataDb(), entityTypeId);
  });
  ipcMain.handle('admin:entities:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) throw new Error('permission denied: masterdata.view');
    return getEntityDetails(ctx.dataDb(), id);
  });
  ipcMain.handle('admin:entities:setAttr', async (_e, entityId: string, code: string, value: unknown) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate;
    return setEntityAttribute(ctx.dataDb(), entityId, code, value);
  });
  ipcMain.handle('admin:entities:deleteInfo', async (_e, entityId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return getIncomingLinksForEntity(ctx.dataDb(), entityId);
  });
  ipcMain.handle('admin:entities:detachLinksAndDelete', async (_e, entityId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return detachIncomingLinksAndSoftDeleteEntity(ctx.dataDb(), entityId);
  });
  ipcMain.handle('admin:entities:softDelete', async (_e, entityId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return softDeleteEntity(ctx.dataDb(), entityId);
  });

  // Users/permissions/delegations are server-side and require admin.users.manage.
  ipcMain.handle('admin:users:list', async () => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminListUsers(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });
  ipcMain.handle(
    'admin:users:create',
    async (
      _e,
      args: { login: string; password: string; role: string; fullName?: string; accessEnabled?: boolean; employeeId?: string },
    ) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminCreateUser(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );
  ipcMain.handle(
    'admin:users:update',
    async ( _e, userId: string, args: { role?: string; accessEnabled?: boolean; password?: string; login?: string; fullName?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminUpdateUser(ctx.sysDb, ctx.mgr.getApiBaseUrl(), userId, args);
    },
  );
  ipcMain.handle(
    'admin:users:pendingApprove',
    async (_e, args: { pendingUserId: string; action: 'approve' | 'merge'; role?: 'user' | 'admin'; targetUserId?: string }) => {
      if (isViewMode(ctx)) return viewModeWriteError() as any;
      await requirePermOrThrow(ctx, 'admin.users.manage');
      return adminPendingApprove(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );
  ipcMain.handle('admin:users:permissionsGet', async (_e, userId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminGetUserPermissions(ctx.sysDb, ctx.mgr.getApiBaseUrl(), userId);
  });
  ipcMain.handle('admin:users:permissionsSet', async (_e, userId: string, set: Record<string, boolean>) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminSetUserPermissions(ctx.sysDb, ctx.mgr.getApiBaseUrl(), userId, set);
  });

  ipcMain.handle('admin:users:delegationsList', async (_e, userId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminListUserDelegations(ctx.sysDb, ctx.mgr.getApiBaseUrl(), userId);
  });
  ipcMain.handle(
    'admin:users:delegationCreate',
    async (_e, args: { fromUserId: string; toUserId: string; permCode: string; startsAt?: number; endsAt: number; note?: string }) => {
      if (isViewMode(ctx)) return viewModeWriteError() as any;
      await requirePermOrThrow(ctx, 'admin.users.manage');
      return adminCreateDelegation(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );
  ipcMain.handle('admin:users:delegationRevoke', async (_e, args: { id: string; note?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError() as any;
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminRevokeDelegation(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args.id, args.note);
  });
}


