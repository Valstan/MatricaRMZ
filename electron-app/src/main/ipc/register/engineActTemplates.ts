import { ipcMain } from 'electron';

import type {
  EngineActTemplateDto,
  EngineActTemplatePayload,
  EngineActTemplateSummary,
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

export function registerEngineActTemplatesIpc(ctx: IpcContext) {
  ipcMain.handle('engineActTemplates:list', async (_e, args?: { engineBrandId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as Err;
    const qs = args?.engineBrandId ? `?engineBrandId=${encodeURIComponent(args.engineBrandId)}` : '';
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/engine-act-templates${qs}`, { method: 'GET' });
    return toResult<{ templates: EngineActTemplateSummary[] }>(r);
  });

  ipcMain.handle('engineActTemplates:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/engine-act-templates/${encodeURIComponent(id)}`, { method: 'GET' });
    return toResult<{ template: EngineActTemplateDto }>(r);
  });

  ipcMain.handle(
    'engineActTemplates:create',
    async (_e, args: { engineBrandId: string; name: string; payload?: EngineActTemplatePayload }) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'engine_act_templates.edit');
      if (!gate.ok) return gate as Err;
      const body: Record<string, unknown> = { engineBrandId: args.engineBrandId, name: args.name };
      if (args.payload !== undefined) body.payload = args.payload;
      const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), '/engine-act-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return toResult<{ template: EngineActTemplateDto }>(r);
    },
  );

  ipcMain.handle(
    'engineActTemplates:update',
    async (_e, args: { id: string; name?: string; payload?: EngineActTemplatePayload }) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'engine_act_templates.edit');
      if (!gate.ok) return gate as Err;
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.payload !== undefined) body.payload = args.payload;
      const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/engine-act-templates/${encodeURIComponent(args.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return toResult<{ template: EngineActTemplateDto }>(r);
    },
  );

  ipcMain.handle('engineActTemplates:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engine_act_templates.edit');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), `/engine-act-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return toResult<{ deleted: true }>(r);
  });
}
