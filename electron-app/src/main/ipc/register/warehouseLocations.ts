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

export function registerWarehouseLocationsIpc(ctx: IpcContext) {
  ipcMain.handle(
    'warehouseLocations:list',
    async (_e, args?: { type?: 'system' | 'workshop' | 'regular'; activeOnly?: boolean }) => {
      const gate = await requirePermOrResult(ctx, 'warehouse_locations.view');
      if (!gate.ok) return gate as Err;
      const qs: string[] = [];
      if (args?.type) qs.push(`type=${encodeURIComponent(args.type)}`);
      if (args?.activeOnly === true) qs.push('activeOnly=true');
      const url = qs.length > 0 ? `/warehouse-locations?${qs.join('&')}` : '/warehouse-locations';
      const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), url, { method: 'GET' });
      return toResult(r);
    },
  );

  ipcMain.handle('warehouseLocations:registerUsage', async () => {
    const gate = await requirePermOrResult(ctx, 'warehouse_locations.view');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(
      ctx.sysDb,
      ctx.mgr.getApiBaseUrl(),
      '/warehouse-locations/register-usage',
      { method: 'GET' },
    );
    return toResult(r);
  });

  ipcMain.handle(
    'warehouseLocations:upsert',
    async (
      _e,
      args: {
        id?: string;
        type: 'workshop' | 'regular';
        code: string;
        name: string;
        workshopId?: string | null;
        isActive?: boolean;
        sortOrder?: number;
        metadataJson?: string | null;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'warehouse_locations.manage');
      if (!gate.ok) return gate as Err;
      const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), '/warehouse-locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      return toResult(r);
    },
  );

  ipcMain.handle('warehouseLocations:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'warehouse_locations.manage');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(
      ctx.sysDb,
      ctx.mgr.getApiBaseUrl(),
      `/warehouse-locations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return toResult(r);
  });
}
