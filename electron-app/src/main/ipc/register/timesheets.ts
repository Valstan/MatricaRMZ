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

export function registerTimesheetsIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle('timesheets:codes', async () => {
    const gate = await requirePermOrResult(ctx, 'timesheet.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), '/timesheets/codes', { method: 'GET' }));
  });

  ipcMain.handle('timesheets:departments', async () => {
    const gate = await requirePermOrResult(ctx, 'timesheet.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), '/timesheets/departments', { method: 'GET' }));
  });

  ipcMain.handle('timesheets:list', async (_e, args?: { workshopId?: string; departmentId?: string; year?: number }) => {
    const gate = await requirePermOrResult(ctx, 'timesheet.view');
    if (!gate.ok) return gate as Err;
    const qp = new URLSearchParams();
    if (args?.workshopId) qp.set('workshopId', String(args.workshopId));
    if (args?.departmentId) qp.set('departmentId', String(args.departmentId));
    if (args?.year) qp.set('year', String(args.year));
    const qs = qp.toString() ? `?${qp.toString()}` : '';
    return toResult(await httpAuthed(ctx.sysDb, base(), `/timesheets${qs}`, { method: 'GET' }));
  });

  ipcMain.handle('timesheets:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'timesheet.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/timesheets/${encodeURIComponent(id)}`, { method: 'GET' }));
  });

  ipcMain.handle('timesheets:create', async (_e, args: { workshopId?: string; departmentId?: string; year: number; month: number; weekMode?: 5 | 6; shiftHours?: number }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'timesheet.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), '/timesheets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) }));
  });

  ipcMain.handle('timesheets:update', async (_e, args: { id: string; status?: 'draft' | 'closed'; weekMode?: 5 | 6; normHours?: number | null; allowOthersEdit?: boolean }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'timesheet.edit');
    if (!gate.ok) return gate as Err;
    const { id, ...body } = args;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/timesheets/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  });

  ipcMain.handle('timesheets:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'timesheet.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/timesheets/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  });

  ipcMain.handle('timesheets:addRows', async (_e, args: { timesheetId: string; employees: Array<{ employeeId: string; tabNumber?: string | null; position?: string | null }> }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'timesheet.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/timesheets/${encodeURIComponent(args.timesheetId)}/rows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employees: args.employees }) }));
  });

  ipcMain.handle('timesheets:reorderRows', async (_e, args: { timesheetId: string; rowIds: string[] }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'timesheet.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/timesheets/${encodeURIComponent(args.timesheetId)}/rows-order`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowIds: args.rowIds }) }));
  });

  ipcMain.handle('timesheets:removeRow', async (_e, rowId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'timesheet.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/timesheets/rows/${encodeURIComponent(rowId)}`, { method: 'DELETE' }));
  });

  ipcMain.handle('timesheets:setCells', async (_e, args: { rowId: string; cells: Array<{ day: number; code?: string | null; hours?: number | null; comment?: string | null }> }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'timesheet.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/timesheets/rows/${encodeURIComponent(args.rowId)}/cells`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cells: args.cells }) }));
  });
}
