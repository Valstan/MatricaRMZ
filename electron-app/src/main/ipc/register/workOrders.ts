import { ipcMain } from 'electron';

import { WorkOrderKind, isSuperadminRole, type WorkOrderPayload, type WorkOrderWorkLine } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import {
  createWorkOrder,
  deleteWorkOrder,
  getActiveAssemblyVariant,
  getWorkOrder,
  listWorkOrders,
  setWorkOrderNumber,
  updateWorkOrder,
} from '../../services/workOrderService.js';
import {
  listEngineRepairPartStates,
  saveInRepairPartStatusEvents,
} from '../../services/partStatusEventService.js';

export function registerWorkOrdersIpc(ctx: IpcContext) {
  ipcMain.handle('workOrders:list', async (_e, args?: { q?: string; month?: string }) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.view');
    if (!gate.ok) return gate as any;
    return listWorkOrders(ctx.dataDb(), { ...(args ?? {}), viewer: await ctx.currentViewer() });
  });

  ipcMain.handle('workOrders:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.view');
    if (!gate.ok) return gate as any;
    return getWorkOrder(ctx.dataDb(), id);
  });

  ipcMain.handle('workOrders:activeAssemblyVariant', async (_e, engineId: string) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.view');
    if (!gate.ok) return gate as any;
    return getActiveAssemblyVariant(ctx.dataDb(), engineId);
  });

  ipcMain.handle('workOrders:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.create');
    if (!gate.ok) return gate as any;
    return createWorkOrder(ctx.dataDb(), await ctx.currentActor());
  });

  ipcMain.handle('workOrders:update', async (_e, args: { id: string; payload: any }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.edit');
    if (!gate.ok) return gate as any;
    return updateWorkOrder(ctx.dataDb(), { id: args.id, payload: args.payload, actor: await ctx.currentActor() });
  });

  ipcMain.handle('workOrders:setNumber', async (_e, args: { id: string; workOrderNumber: number }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.edit');
    if (!gate.ok) return gate as any;
    const viewer = await ctx.currentViewer();
    if (!isSuperadminRole(viewer.role)) {
      return { ok: false as const, error: 'permission denied: сменить номер наряда может только суперадминистратор' };
    }
    return setWorkOrderNumber(ctx.dataDb(), {
      id: args.id,
      workOrderNumber: Number(args.workOrderNumber),
      actor: await ctx.currentActor(),
    });
  });

  ipcMain.handle('workOrders:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.edit');
    if (!gate.ok) return gate as any;
    return deleteWorkOrder(ctx.dataDb(), { id, actor: await ctx.currentActor() });
  });

  // Stage 4 нитки assembly-work-order-from-forecast: создаём Assembly-наряд из строки прогноза.
  // Создаёт пустой наряд через createWorkOrder, патчит payload (workOrderKind=Assembly,
  // forecastVariantKey, freeWorks из requiredParts). Привязка двигателя/цеха/складов — оператор
  // делает в карточке наряда. Резервация деталей — отдельным шагом «Сохранить как черновик».
  ipcMain.handle(
    'workOrders:createAssemblyFromForecast',
    async (
      _e,
      args: {
        variantKey: string;
        brandId: string;
        engineBrandName?: string;
        /** Phase 2.4 PR 1: каждая required-part строка может опционально нести
         * предлагаемый склад (warehouse_locations.id, uuid). Если задан — попадает
         * в `line.sourceWarehouseId` нового наряда; иначе оператор выбирает в карточке. */
        requiredParts: Array<{ partId: string; qty: number; partLabel: string; sourceWarehouseId?: string }>;
        /** Stage 4 followup (v1.29.2): если прогноз построен с фильтром
         * `assemblyForecastOnSiteOnly`, строка уже привязана к конкретному engine.
         * Прокидываем в наряд: line.engineId/engineNumber/engineBrandId/engineBrandName
         * + operation.engineEntityId, чтобы оператор сразу мог «Сохранить как черновик». */
        engineId?: string;
        engineNumber?: string;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'work_orders.create');
      if (!gate.ok) return gate as any;
      if (!args?.variantKey) return { ok: false, error: 'variantKey обязателен' };
      if (!Array.isArray(args.requiredParts) || args.requiredParts.length === 0) {
        return { ok: false, error: 'Список требуемых деталей пуст' };
      }
      const actor = await ctx.currentActor();
      const created = await createWorkOrder(ctx.dataDb(), actor);
      if (!created.ok) return created;
      const engineId = args.engineId ? String(args.engineId).trim() : '';
      const engineNumber = args.engineNumber ? String(args.engineNumber).trim() : '';
      const freeWorks: WorkOrderWorkLine[] = args.requiredParts
        .filter((p) => p.partId && p.qty > 0)
        .map((p, idx) => {
          const line: WorkOrderWorkLine = {
            lineNo: idx + 1,
            serviceId: null,
            serviceName: '',
            unit: 'шт',
            qty: Math.max(0, Math.floor(p.qty)),
            priceRub: 0,
            amountRub: 0,
            partId: p.partId,
            partName: p.partLabel || '',
          };
          if (engineId) line.engineId = engineId;
          if (engineNumber) line.engineNumber = engineNumber;
          if (args.brandId) line.engineBrandId = args.brandId;
          if (args.engineBrandName) line.engineBrandName = args.engineBrandName;
          const proposedWarehouse = p.sourceWarehouseId ? String(p.sourceWarehouseId).trim() : '';
          if (proposedWarehouse) line.sourceWarehouseId = proposedWarehouse;
          return line;
        });
      const nextPayload: WorkOrderPayload = {
        ...created.payload,
        workOrderKind: WorkOrderKind.Assembly,
        forecastVariantKey: args.variantKey,
        freeWorks,
      };
      const updated = await updateWorkOrder(ctx.dataDb(), { id: created.id, payload: nextPayload, actor });
      if (!updated.ok) return updated;
      return { ok: true, id: created.id, workOrderNumber: updated.workOrderNumber };
    },
  );

  // Ф5 актов двигателя (GAP-4 вход): Repair-наряд из строк дефектовки «свой ремонт».
  // Тот же приём, что createAssemblyFromForecast: пустой наряд → patch payload
  // (workOrderKind=Repair, freeWorks с partId/engineId). Цех/услуги/цены — оператор
  // в карточке наряда. После создания пишем part_status_event 'in_repair' per-деталь.
  ipcMain.handle(
    'workOrders:createRepairFromDefects',
    async (
      _e,
      args: {
        engineId: string;
        engineNumber?: string;
        engineBrandId?: string;
        engineBrandName?: string;
        items: Array<{ partId: string; qty: number; partLabel: string }>;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'work_orders.create');
      if (!gate.ok) return gate as any;
      const engineId = String(args?.engineId ?? '').trim();
      if (!engineId) return { ok: false, error: 'engineId обязателен' };
      const items = (Array.isArray(args.items) ? args.items : [])
        .map((it) => ({
          partId: String(it?.partId ?? '').trim(),
          qty: Math.max(0, Math.trunc(Number(it?.qty ?? 0))),
          partLabel: String(it?.partLabel ?? '').trim() || 'Деталь',
        }))
        .filter((it) => it.partId && it.qty > 0);
      if (items.length === 0) return { ok: false, error: 'Нет деталей на ветке «свой ремонт»' };
      const actor = await ctx.currentActor();
      const created = await createWorkOrder(ctx.dataDb(), actor);
      if (!created.ok) return created;
      const engineNumber = args.engineNumber ? String(args.engineNumber).trim() : '';
      const engineBrandId = args.engineBrandId ? String(args.engineBrandId).trim() : '';
      const engineBrandName = args.engineBrandName ? String(args.engineBrandName).trim() : '';
      const freeWorks: WorkOrderWorkLine[] = items.map((it, idx) => {
        const line: WorkOrderWorkLine = {
          lineNo: idx + 1,
          serviceId: null,
          serviceName: '',
          unit: 'шт',
          qty: it.qty,
          priceRub: 0,
          amountRub: 0,
          partId: it.partId,
          partName: it.partLabel,
          engineId,
        };
        if (engineNumber) line.engineNumber = engineNumber;
        if (engineBrandId) line.engineBrandId = engineBrandId;
        if (engineBrandName) line.engineBrandName = engineBrandName;
        return line;
      });
      const nextPayload: WorkOrderPayload = {
        ...created.payload,
        workOrderKind: WorkOrderKind.Repair,
        freeWorks,
      };
      const updated = await updateWorkOrder(ctx.dataDb(), { id: created.id, payload: nextPayload, actor });
      if (!updated.ok) return updated;
      const events = await saveInRepairPartStatusEvents(ctx.dataDb(), {
        engineId,
        items,
        workOrderOperationId: created.id,
        workOrderNumber: updated.workOrderNumber,
        actor,
      });
      if (!events.ok) console.warn('[workOrders:createRepairFromDefects] part_status_event skipped:', events.error);
      return { ok: true, id: created.id, workOrderNumber: updated.workOrderNumber };
    },
  );

  // Ф5 (GAP-4): производные статусы «в ремонте/готова к сборке» по деталям двигателя.
  // Гейт operations.view (не work_orders.view) — статусы показываются в панели списка
  // деталей карточки двигателя, у её аудитории прав на раздел нарядов может не быть.
  ipcMain.handle('workOrders:engineRepairPartStates', async (_e, engineId: string) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as any;
    return listEngineRepairPartStates(ctx.dataDb(), engineId);
  });
}

