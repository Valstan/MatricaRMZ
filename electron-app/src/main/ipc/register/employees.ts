import { randomUUID } from 'node:crypto';

import { ipcMain } from 'electron';
import { and, eq, isNull } from 'drizzle-orm';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { createEntity, getEntityDetails, listEntitiesByType, listEntitiesByTypeWithAttrs, setEntityAttribute, softDeleteEntity } from '../../services/entityService.js';
import { analyzeEmployeeDuplicatesRemote, deleteEmployeeRemote, getSectionMembershipByLogin, getSectionMembershipByUserId, listEmployeeAttributeDefs, listEmployeesSummary, mergeEmployeeDuplicatesRemote, mergeEmployeesToServer } from '../../services/employeeService.js';
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

/**
 * Ключ сравнения должностей: регистр, ё→е и лишние пробелы не должны плодить дубли
 * («Водитель  погрузчика» и «водитель погрузчика» — одна должность).
 */
function normalizePositionKey(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

export function registerEmployeesIpc(ctx: IpcContext) {
  // Self-read собственного membership «доступа по разделам» — без permission-гейта
  // (пользователь читает только своё; null = не засеяно → меню работает fail-open).
  ipcMain.handle('access:sections:self', async () => {
    const viewer = await ctx.currentViewer();
    if (!viewer.login) return null;
    if (String(viewer.role ?? '').toLowerCase() === 'superadmin') return null; // bypass — гейтинг не применяется
    return getSectionMembershipByLogin(ctx.dataDb(), viewer.login);
  });

  ipcMain.handle('employees:list', async () => {
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) return [];
    return listEmployeesSummary(ctx.dataDb(), ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('employees:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) throw new Error(gate.error);
    // Pass the employee type so a not-yet-saved (deferred) employee opens as an empty card.
    const typeId = await getEntityTypeIdByCode(ctx, 'employee');
    return getEntityDetails(ctx.dataDb(), id, typeId ?? undefined);
  });

  ipcMain.handle('employees:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return gate;
    // Deferred create (Phase 2): allocate the id only — the entity row is materialized on the
    // first employees:setAttr, so an abandoned blank employee never persists or syncs.
    return { ok: true as const, id: randomUUID() };
  });

  ipcMain.handle('employees:setAttr', async (_e, employeeId: string, code: string, value: unknown) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return gate;
    // fallback type id materializes the entity on the first write for a deferred employee.
    const typeId = await getEntityTypeIdByCode(ctx, 'employee');
    return setEntityAttribute(ctx.dataDb(), employeeId, code, value, typeId ?? undefined);
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

  // Дубли сотрудников: анализ читает, слияние правит живые данные — оба под правом создания
  // сотрудников, оба идут на сервер (там вторая половина сотрудника: users, права, чат).
  ipcMain.handle('employees:dedupeAnalyze', async () => {
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return gate;
    return analyzeEmployeeDuplicatesRemote(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('employees:dedupeMerge', async (_e, args: { survivorId: string; loserId: string; dryRun?: boolean }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return gate;
    const result = await mergeEmployeeDuplicatesRemote(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
      survivorId: String(args?.survivorId ?? ''),
      loserId: String(args?.loserId ?? ''),
      ...(args?.dryRun === true ? { dryRun: true } : {}),
    });
    // После боевого слияния подтягиваем изменения: карточка вторичного погашена на сервере.
    if (result.ok && args?.dryRun !== true) await ctx.mgr.runOnce().catch(() => {});
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

  // Должности. Карточка сотрудника заводит их в справочник `position_ref` сама
  // (кнопка «+Создать» под полем «Должность»). Раньше она шла общей дверью
  // `admin:entities:*`, которая требует masterdata.edit, — и кадровик, вносящий
  // новых сотрудников, упирался в отказ, хотя весь остальной справочник ему не
  // нужен. Выдавать masterdata.edit ради должностей нельзя: та же галочка
  // открывает товары, бренды и услуги. Поэтому у карточки своя узкая дверь на
  // employees.view / employees.create — серверная сторона справочник должностей
  // и так не гейтит (в ledgerAuthz `position_ref` не замаплен → open).
  ipcMain.handle('employees:positions:list', async () => {
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) return [];
    const typeId = await getEntityTypeIdByCode(ctx, 'position_ref');
    if (!typeId) return [];
    return listEntitiesByType(ctx.dataDb(), typeId);
  });

  ipcMain.handle('employees:positions:create', async (_e, label: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'employees.create');
    if (!gate.ok) return gate;
    const name = String(label ?? '').trim();
    if (!name) return { ok: false as const, error: 'пустое название должности' };
    const typeId = await getEntityTypeIdByCode(ctx, 'position_ref');
    if (!typeId) return { ok: false as const, error: 'справочник должностей не найден' };
    // Двое кадровиков вводят одну должность — возвращаем существующую, а не
    // вторую строку в справочнике.
    const key = normalizePositionKey(name);
    const existing = await listEntitiesByTypeWithAttrs(ctx.dataDb(), typeId);
    const hit = existing.find((row) => normalizePositionKey(String(row.attributes['name'] ?? '')) === key);
    if (hit) return { ok: true as const, id: hit.id, reused: true };
    const created = await createEntity(ctx.dataDb(), typeId);
    if (!created.ok) return created;
    const saved = await setEntityAttribute(ctx.dataDb(), created.id, 'name', name);
    if (!saved.ok) return saved;
    return { ok: true as const, id: created.id, reused: false };
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

  // B3/R4b: membership ОДНОГО сотрудника из локальной реплики — показ зеркала
  // в карточке. Гейт тот же, что у permissionsGet (employees.view).
  ipcMain.handle('employees:sectionMembershipGet', async (_e, userId: string) => {
    const gate = await requirePermOrResult(ctx, 'employees.view');
    if (!gate.ok) return { ok: false as const, error: gate.error };
    const membership = await getSectionMembershipByUserId(ctx.dataDb(), String(userId ?? ''));
    return { ok: true as const, membership };
  });
}
