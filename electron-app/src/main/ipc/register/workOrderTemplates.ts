import { ipcMain } from 'electron';

import type {
  WorkOrderKind,
  WorkOrderTemplateDto,
  WorkOrderTemplateLine,
  WorkOrderTemplateSummary,
} from '@matricarmz/shared';

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

export function registerWorkOrderTemplatesIpc(ctx: IpcContext) {
  ipcMain.handle('workOrderTemplates:list', async (_e, args?: { kind?: WorkOrderKind }) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.create');
    if (!gate.ok) return gate as Err;
    const qs = args?.kind ? `?kind=${encodeURIComponent(args.kind)}` : '';
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/work-order-templates${qs}`, {
      method: 'GET',
    });
    return toResult<{ templates: WorkOrderTemplateSummary[] }>(r);
  });

  ipcMain.handle('workOrderTemplates:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'work_orders.create');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(
      ctx.sysDb,
      ctx.mgr.getApiBaseUrl(),
      `/work-order-templates/${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
    return toResult<{ template: WorkOrderTemplateDto }>(r);
  });

  ipcMain.handle(
    'workOrderTemplates:create',
    async (
      _e,
      args: {
        workOrderKind: WorkOrderKind;
        name: string;
        payloadOverrides?: Record<string, unknown>;
        hiddenFields?: string[];
        lines?: WorkOrderTemplateLine[];
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'work_order_templates.edit');
      if (!gate.ok) return gate as Err;
      const body: Record<string, unknown> = {
        workOrderKind: args.workOrderKind,
        name: args.name,
      };
      if (args.payloadOverrides !== undefined) body.payloadOverrides = args.payloadOverrides;
      if (args.hiddenFields !== undefined) body.hiddenFields = args.hiddenFields;
      if (args.lines !== undefined) body.lines = args.lines;
      const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), '/work-order-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return toResult<{ template: WorkOrderTemplateDto }>(r);
    },
  );

  ipcMain.handle(
    'workOrderTemplates:update',
    async (
      _e,
      args: {
        id: string;
        name?: string;
        payloadOverrides?: Record<string, unknown>;
        hiddenFields?: string[];
        lines?: WorkOrderTemplateLine[];
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'work_order_templates.edit');
      if (!gate.ok) return gate as Err;
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.payloadOverrides !== undefined) body.payloadOverrides = args.payloadOverrides;
      if (args.hiddenFields !== undefined) body.hiddenFields = args.hiddenFields;
      if (args.lines !== undefined) body.lines = args.lines;
      const r = await httpAuthed(
        ctx.sysDb,
        ctx.mgr.getApiBaseUrl(),
        `/work-order-templates/${encodeURIComponent(args.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return toResult<{ template: WorkOrderTemplateDto }>(r);
    },
  );

  ipcMain.handle('workOrderTemplates:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_order_templates.edit');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(
      ctx.sysDb,
      ctx.mgr.getApiBaseUrl(),
      `/work-order-templates/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return toResult<{ deleted: true }>(r);
  });
}
