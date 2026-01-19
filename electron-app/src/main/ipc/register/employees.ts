import { ipcMain } from 'electron';
import { and, eq, isNull } from 'drizzle-orm';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { createEntity, getEntityDetails, listEntitiesByType, setEntityAttribute } from '../../services/entityService.js';
import { viewUserPermissions } from '../../services/adminUsersService.js';
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
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return [];
    const typeId = await getEntityTypeIdByCode(ctx, 'employee');
    if (!typeId) return [];
    return listEntitiesByType(ctx.dataDb(), typeId);
  });

  ipcMain.handle('employees:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'employees.create');
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

  ipcMain.handle('employees:departments:list', async () => {
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return [];
    const typeId = await getEntityTypeIdByCode(ctx, 'department');
    if (!typeId) return [];
    return listEntitiesByType(ctx.dataDb(), typeId);
  });

  ipcMain.handle('employees:permissionsGet', async (_e, userId: string) => {
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return { ok: false as const, error: gate.error };
    return viewUserPermissions(ctx.sysDb, ctx.mgr.getApiBaseUrl(), userId);
  });
}
