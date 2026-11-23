import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { httpAuthed } from '../../services/httpClient.js';
import { httpFailureText } from '../../services/httpFailureText.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

function toResult<T>(r: { ok: boolean; status: number; json?: unknown; text?: string }): Result<T> {
  if (r.ok && r.json && typeof r.json === 'object') return r.json as Result<T>;
  if (r.ok) return { ok: true } as Ok<T>;
  const msg = httpFailureText(r);
  return { ok: false, error: String(msg) };
}

export function registerWorkOrderSignatureCaptionsIpc(ctx: IpcContext) {
  ipcMain.handle('signatureCaptions:list', async () => {
    const gate = await requirePermOrResult(ctx, 'work_orders.create');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), '/work-order-signature-captions', {
      method: 'GET',
    });
    return toResult<{ captions: string[] }>(r);
  });

  ipcMain.handle('signatureCaptions:add', async (_e, args: { text: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'work_orders.create');
    if (!gate.ok) return gate as Err;
    const r = await httpAuthed(ctx.sysDb, ctx.mgr.getApiBaseUrl(), '/work-order-signature-captions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(args?.text ?? '') }),
    });
    return toResult<{ added: boolean }>(r);
  });
}
