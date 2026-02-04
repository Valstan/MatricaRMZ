import { ipcMain } from 'electron';
import { and, eq, isNull } from 'drizzle-orm';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { createEntity, getEntityDetails, listEntitiesByType, setEntityAttribute, softDeleteEntity } from '../../services/entityService.js';
import { deleteEmployeeRemote, listEmployeeAttributeDefs, listEmployeesSummary, mergeEmployeesToServer } from '../../services/employeeService.js';
import { adminResyncEmployees, viewUserPermissions } from '../../services/adminUsersService.js';
import { entityTypes } from '../../database/schema.js';

async function getEntityTypeIdByCode(ctx: IpcContext, code: string): Promise<string | null> {
  const rows = await ctx
    .dataDb()
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

export function registerEmployeesIpc(ctx: IpcContext) {
  ipcMain.handle('employees:list', async () => {
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) return [];
    return listEmployeesSummary(ctx.dataDb(), ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('employees:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) throw new Error(gate.error);
    return getEntityDetails(ctx.dataDb(), id);
  });

  ipcMain.handle('employees:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return gate;
    const typeId = await getEntityTypeIdByCode(ctx, 'employee');
    if (!typeId) return { ok: false as const, error: 'employee type not found' };
    return createEntity(ctx.dataDb(), typeId);
  });

  ipcMain.handle('employees:setAttr', async (_e, employeeId: string, code: string, value: unknown) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return gate;
    return setEntityAttribute(ctx.dataDb(), employeeId, code, value);
  });

  ipcMain.handle('employees:delete', async (_e, employeeId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return gate;
    const remote = await deleteEmployeeRemote(ctx.sysDb, ctx.mgr.getApiBaseUrl(), employeeId);
    if (!remote.ok) return remote;
    if (remote.mode === 'deleted') {
      const local = await softDeleteEntity(ctx.dataDb(), employeeId);
      if (!local.ok) return local;
      await ctx.mgr.runOnce().catch(() => {});
      return local;
    }
    return { ok: true as const, mode: remote.mode ?? 'requested' };
  });

  ipcMain.handle('employees:merge', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return gate;
    const result = await mergeEmployeesToServer(ctx.dataDb(), ctx.sysDb, ctx.mgr.getApiBaseUrl());
    if (!result.ok) return result;
    await ctx.mgr.runOnce().catch(() => {});
    return result;
  });

  ipcMain.handle('employees:resyncFromServer', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) return gate;
    const resync = await adminResyncEmployees(ctx.sysDb, ctx.mgr.getApiBaseUrl());
    if (!resync.ok) return resync;
    const sync = await ctx.mgr.runOnce().catch((e) => ({ ok: false as const, error: String(e) }));
    return { ok: true as const, resync, sync };
  });

  ipcMain.handle('employees:departments:list', async () => {
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) return [];
    const typeId = await getEntityTypeIdByCode(ctx, 'department');
    if (!typeId) return [];
    return listEntitiesByType(ctx.dataDb(), typeId);
  });

  ipcMain.handle('employees:defs', async () => {
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) return [];
    return listEmployeeAttributeDefs(ctx.dataDb());
  });

  ipcMain.handle('employees:permissionsGet', async (_e, userId: string) => {
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return viewUserPermissions(ctx.sysDb, ctx.mgr.getApiBaseUrl(), userId);
  });
}
