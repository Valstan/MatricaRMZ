import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { httpAuthed } from '../../services/httpClient.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

function toResult<T>(r: { ok: boolean; status: number; json?: unknown; text?: string }): Result<T> {
  if (r.ok && r.json && typeof r.json === 'object') return r.json as Result<T>;
  if (r.ok) return { ok: true } as Ok<T>;
  const errPayload = r.json as { error?: unknown } | null;
  const msg = (errPayload && typeof errPayload.error === 'string' ? errPayload.error : r.text) || `HTTP ${r.status}`;
  return { ok: false, error: String(msg) };
}

export function registerWorkshopsIpc(ctx: IpcContext) {
  ipcMain.handle('workshops:list', async (_e, args?: { activeOnly?: boolean }) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as Err;
    const qs = args?.activeOnly === true ? '?activeOnly=true' : '';
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/workshops${qs}`, { method: 'GET' });
    return toResult(r);
  });

  ipcMain.handle('workshops:stats', async (_e, args?: { from?: string; to?: string; workshopId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'erp.registers.view');
    if (!gate.ok) return gate as Err;
    const qp = new URLSearchParams();
    if (args?.from) qp.set('from', String(args.from));
    if (args?.to) qp.set('to', String(args.to));
    if (args?.workshopId) qp.set('workshopId', String(args.workshopId));
    const qs = qp.toString() ? `?${qp.toString()}` : '';
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/workshops/stats${qs}`, { method: 'GET' });
    return toResult(r);
  });

  ipcMain.handle('workshops:upsert', async (_e, args: { id?: string; code: string; name: string; isActive?: boolean; displayOrder?: number; metadataJson?: string | null }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'workshops.manage');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), '/workshops', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return toResult(r);
  });

  ipcMain.handle('workshops:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'workshops.manage');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/workshops/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return toResult(r);
  });

  // Per-workshop repair template (Stage 4 of workshop-work-order plan).
  // GET — открыт всем с правом создания нарядов (для autofill freeWorks при
  // создании Workshop-наряда). PUT — только адресная permission
  // 'workshop_repair_templates.edit' (adminOnly), бэк дополнительно проверяет.
  ipcMain.handle('workshops:getRepairTemplate', async (_e, workshopId: string) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.create');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(
      ctx.sysDb,
      ctx.mgr.getApiBaseUrl(),
      `/workshops/${encodeURIComponent(workshopId)}/repair-template`,
      { method: 'GET' },
    );
    return toResult(r);
  });

  ipcMain.handle(
    'workshops:setRepairTemplate',
    async (_e, args: { workshopId: string; lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }> }) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'workshop_repair_templates.edit');
      if (!gate.ok) return gate as Err;
      const r = await httpAuthed(
        ctx.sysDb,
        ctx.mgr.getApiBaseUrl(),
        `/workshops/${encodeURIComponent(args.workshopId)}/repair-template`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines: args.lines }),
        },
      );
      return toResult(r);
    },
  );

  // ─── Multi-template CRUD (v1.27.0) ─────────────────────────────────────────
  // Множественные шаблоны на цех. GET — открыт всем с правом создания нарядов.
  // POST/PUT/DELETE — workshop_repair_templates.edit (adminOnly).

  ipcMain.handle('workshops:listRepairTemplates', async (_e, workshopId: string) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.create');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(
      ctx.sysDb,
      ctx.mgr.getApiBaseUrl(),
      `/workshops/${encodeURIComponent(workshopId)}/repair-templates`,
      { method: 'GET' },
    );
    return toResult(r);
  });

  ipcMain.handle(
    'workshops:getRepairTemplateById',
    async (_e, args: { workshopId: string; templateId: string }) => {
      const gate = await requirePermOrResult(ctx, 'work_orders.create');
      if (!gate.ok) return gate as Err;
      const r = await httpAuthed(
        ctx.sysDb,
        ctx.mgr.getApiBaseUrl(),
        `/workshops/${encodeURIComponent(args.workshopId)}/repair-templates/${encodeURIComponent(args.templateId)}`,
        { method: 'GET' },
      );
      return toResult(r);
    },
  );

  ipcMain.handle(
    'workshops:createRepairTemplate',
    async (
      _e,
      args: {
        workshopId: string;
        name: string;
        lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'workshop_repair_templates.edit');
      if (!gate.ok) return gate as Err;
      const r = await httpAuthed(
        ctx.sysDb,
        ctx.mgr.getApiBaseUrl(),
        `/workshops/${encodeURIComponent(args.workshopId)}/repair-templates`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: args.name, lines: args.lines }),
        },
      );
      return toResult(r);
    },
  );

  ipcMain.handle(
    'workshops:updateRepairTemplate',
    async (
      _e,
      args: {
        workshopId: string;
        templateId: string;
        name?: string;
        lines?: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'workshop_repair_templates.edit');
      if (!gate.ok) return gate as Err;
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.lines !== undefined) body.lines = args.lines;
      const r = await httpAuthed(
        ctx.sysDb,
        ctx.mgr.getApiBaseUrl(),
        `/workshops/${encodeURIComponent(args.workshopId)}/repair-templates/${encodeURIComponent(args.templateId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return toResult(r);
    },
  );

  ipcMain.handle(
    'workshops:deleteRepairTemplate',
    async (_e, args: { workshopId: string; templateId: string }) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'workshop_repair_templates.edit');
      if (!gate.ok) return gate as Err;
      const r = await httpAuthed(
        ctx.sysDb,
        ctx.mgr.getApiBaseUrl(),
        `/workshops/${encodeURIComponent(args.workshopId)}/repair-templates/${encodeURIComponent(args.templateId)}`,
        { method: 'DELETE' },
      );
      return toResult(r);
    },
  );

  // Batch остатков для склада цеха — для live колонки «Остаток в цеху» в
  // Workshop-наряде. POST на бэке (длинный список IDs не пройдёт в URL).
  ipcMain.handle(
    'warehouse:stockBalancesByWorkshop',
    async (_e, args: { workshopId: string; nomenclatureIds: string[] }) => {
      const gate = await requirePermOrResult(ctx, 'parts.view');
      if (!gate.ok) return gate as Err;
      const r = await httpAuthed(
        ctx.sysDb,
        ctx.mgr.getApiBaseUrl(),
        '/warehouse/stock-balances/by-workshop',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        },
      );
      return toResult(r);
    },
  );

  ipcMain.handle('workOrders:close', async (_e, args: { operationId: string; expectedUpdatedAt?: number }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.close');
    if (!gate.ok) return gate as Err;
    const body: Record<string, unknown> = {};
    if (args.expectedUpdatedAt !== undefined) body.expectedUpdatedAt = args.expectedUpdatedAt;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-orders/${encodeURIComponent(args.operationId)}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return toResult(r);
  });

  ipcMain.handle('workOrders:saveAssemblyDraft', async (_e, args: { operationId: string; expectedUpdatedAt?: number }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.close');
    if (!gate.ok) return gate as Err;
    const body: Record<string, unknown> = {};
    if (args.expectedUpdatedAt !== undefined) body.expectedUpdatedAt = args.expectedUpdatedAt;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-orders/${encodeURIComponent(args.operationId)}/save-assembly-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return toResult(r);
  });

  ipcMain.handle('workOrders:issueAssembly', async (_e, args: { operationId: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.edit');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-orders/${encodeURIComponent(args.operationId)}/issue-assembly`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return toResult(r);
  });

  ipcMain.handle('workOrders:setIssuedState', async (_e, args: { operationId: string; issued: boolean; reason?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.edit');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-orders/${encodeURIComponent(args.operationId)}/issued-state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issued: args.issued, ...(args.reason ? { reason: args.reason } : {}) }),
    });
    return toResult(r);
  });

  ipcMain.handle('workOrders:requestAssemblyShortageApproval', async (_e, args: { operationId: string; reason: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.edit');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-orders/${encodeURIComponent(args.operationId)}/shortage-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: args.reason }),
    });
    return toResult(r);
  });

  ipcMain.handle('workOrders:getAssemblyShortageApproval', async (_e, args: { operationId: string }) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.view');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-orders/${encodeURIComponent(args.operationId)}/shortage-approval`, { method: 'GET' });
    return toResult(r);
  });

  ipcMain.handle('workOrders:decideAssemblyShortageApproval', async (_e, args: { approvalId: string; approve: boolean; reason: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.assembly_shortage_approve');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-orders/shortage-approvals/${encodeURIComponent(args.approvalId)}/decision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: args.approve, reason: args.reason }),
    });
    return toResult(r);
  });

  ipcMain.handle('workOrders:postAssembly', async (_e, args: { operationId: string; expectedUpdatedAt?: number }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.close');
    if (!gate.ok) return gate as Err;
    const body: Record<string, unknown> = {};
    if (args.expectedUpdatedAt !== undefined) body.expectedUpdatedAt = args.expectedUpdatedAt;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-orders/${encodeURIComponent(args.operationId)}/post-assembly`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return toResult(r);
  });

  ipcMain.handle('workOrders:deleteAssemblyDraft', async (_e, args: { operationId: string; expectedUpdatedAt?: number }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.close');
    if (!gate.ok) return gate as Err;
    const body: Record<string, unknown> = {};
    if (args.expectedUpdatedAt !== undefined) body.expectedUpdatedAt = args.expectedUpdatedAt;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-orders/${encodeURIComponent(args.operationId)}/delete-assembly-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return toResult(r);
  });

  ipcMain.handle('workOrders:assemblyReturn', async (_e, args: {
    engineId: string;
    reason?: string | null;
    docDate?: number;
    lines: Array<{ nomenclatureId: string; qty: number; mode: 'rework' | 'scrap' }>;
  }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'warehouse.assembly_return');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), '/work-orders/assembly-return', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return toResult(r);
  });

  ipcMain.handle('workOrders:assemblyInProgress', async (_e, engineId: string) => {
    const gate = await requirePermOrResult(ctx, 'warehouse.assembly_return');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(
      ctx.sysDb,
      ctx.mgr.getApiBaseUrl(),
      `/work-orders/assembly-in-progress/${encodeURIComponent(String(engineId ?? ''))}`,
      { method: 'GET' },
    );
    return toResult(r);
  });
}
