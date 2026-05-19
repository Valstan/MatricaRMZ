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

  ipcMain.handle('workOrders:assemblyReturn', async (_e, args: {
    engineId: string;
    reason?: string | null;
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
}
