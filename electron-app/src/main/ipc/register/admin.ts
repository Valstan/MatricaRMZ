import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult, requirePermOrThrow } from '../ipcContext.js';

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
  adminRevokeDelegation,
  adminSetUserPermissions,
  adminUpdateUser,
} from '../../services/adminUsersService.js';

export function registerAdminIpc(ctx: IpcContext) {
  // Master-data: EntityTypes/AttributeDefs/Entities
  ipcMain.handle('admin:entityTypes:list', async () => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return [];
    return listEntityTypes(ctx.db);
  });
  ipcMain.handle('admin:entityTypes:upsert', async (_e, args: { id?: string; code: string; name: string }) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate;
    return upsertEntityType(ctx.db, args);
  });
  ipcMain.handle('admin:entityTypes:deleteInfo', async (_e, entityTypeId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return getEntityTypeDeleteInfo(ctx.db, entityTypeId);
  });
  ipcMain.handle(
    'admin:entityTypes:delete',
    async (_e, args: { entityTypeId: string; deleteEntities: boolean; deleteDefs: boolean }) => {
      const gate = await requirePermOrResult(ctx, 'masterdata.edit');
      if (!gate.ok) return gate as any;
      return deleteEntityType(ctx.db, args.entityTypeId, { deleteEntities: !!args.deleteEntities, deleteDefs: !!args.deleteDefs });
    },
  );

  ipcMain.handle('admin:attributeDefs:listByEntityType', async (_e, entityTypeId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return [];
    return listAttributeDefsByEntityType(ctx.db, entityTypeId);
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
      const gate = await requirePermOrResult(ctx, 'masterdata.edit');
      if (!gate.ok) return gate;
      return upsertAttributeDef(ctx.db, args);
    },
  );
  ipcMain.handle('admin:attributeDefs:deleteInfo', async (_e, attributeDefId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return getAttributeDefDeleteInfo(ctx.db, attributeDefId);
  });
  ipcMain.handle(
    'admin:attributeDefs:delete',
    async (_e, args: { attributeDefId: string; deleteValues: boolean }) => {
      const gate = await requirePermOrResult(ctx, 'masterdata.edit');
      if (!gate.ok) return gate as any;
      return deleteAttributeDef(ctx.db, args.attributeDefId, { deleteValues: !!args.deleteValues });
    },
  );

  ipcMain.handle('admin:entities:listByEntityType', async (_e, entityTypeId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return [];
    return listEntitiesByType(ctx.db, entityTypeId);
  });
  ipcMain.handle('admin:entities:create', async (_e, entityTypeId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return createEntity(ctx.db, entityTypeId);
  });
  ipcMain.handle('admin:entities:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) throw new Error('permission denied: masterdata.view');
    return getEntityDetails(ctx.db, id);
  });
  ipcMain.handle('admin:entities:setAttr', async (_e, entityId: string, code: string, value: unknown) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate;
    return setEntityAttribute(ctx.db, entityId, code, value);
  });
  ipcMain.handle('admin:entities:deleteInfo', async (_e, entityId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return getIncomingLinksForEntity(ctx.db, entityId);
  });
  ipcMain.handle('admin:entities:detachLinksAndDelete', async (_e, entityId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return detachIncomingLinksAndSoftDeleteEntity(ctx.db, entityId);
  });
  ipcMain.handle('admin:entities:softDelete', async (_e, entityId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as any;
    return softDeleteEntity(ctx.db, entityId);
  });

  // Users/permissions/delegations are server-side and require admin.users.manage.
  ipcMain.handle('admin:users:list', async () => {
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminListUsers(ctx.db, ctx.mgr.getApiBaseUrl());
  });
  ipcMain.handle('admin:users:create', async (_e, args: { username: string; password: string; role: string }) => {
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminCreateUser(ctx.db, ctx.mgr.getApiBaseUrl(), args);
  });
  ipcMain.handle('admin:users:update', async (_e, userId: string, args: { role?: string; isActive?: boolean; password?: string }) => {
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminUpdateUser(ctx.db, ctx.mgr.getApiBaseUrl(), userId, args);
  });
  ipcMain.handle('admin:users:permissionsGet', async (_e, userId: string) => {
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminGetUserPermissions(ctx.db, ctx.mgr.getApiBaseUrl(), userId);
  });
  ipcMain.handle('admin:users:permissionsSet', async (_e, userId: string, set: Record<string, boolean>) => {
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminSetUserPermissions(ctx.db, ctx.mgr.getApiBaseUrl(), userId, set);
  });

  ipcMain.handle('admin:users:delegationsList', async (_e, userId: string) => {
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminListUserDelegations(ctx.db, ctx.mgr.getApiBaseUrl(), userId);
  });
  ipcMain.handle(
    'admin:users:delegationCreate',
    async (_e, args: { fromUserId: string; toUserId: string; permCode: string; startsAt?: number; endsAt: number; note?: string }) => {
      await requirePermOrThrow(ctx, 'admin.users.manage');
      return adminCreateDelegation(ctx.db, ctx.mgr.getApiBaseUrl(), args);
    },
  );
  ipcMain.handle('admin:users:delegationRevoke', async (_e, args: { id: string; note?: string }) => {
    await requirePermOrThrow(ctx, 'admin.users.manage');
    return adminRevokeDelegation(ctx.db, ctx.mgr.getApiBaseUrl(), args.id, args.note);
  });
}


