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

/**
 * Кладовщик (СИЗ) живёт только на сервере (REST `/ppe/*`), в реплику нормы и
 * карточки попадают pull'ом для отчётов, но UI читает/пишет напрямую — как
 * приказы о ценах (servicePricing.ts). Права те же, что у справочников ERP,
 * выдача — как проведение документа (создаёт и сразу проводит stock_issue).
 */
export function registerPpeIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle('ppe:norms:list', async (_e, args?: { postTitle?: string }) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    const qs = args?.postTitle ? `?postTitle=${encodeURIComponent(args.postTitle)}` : '';
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/norms${qs}`, { method: 'GET' }));
  });

  ipcMain.handle('ppe:norms:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/norms/${encodeURIComponent(String(id || ''))}`, { method: 'GET' }));
  });

  ipcMain.handle(
    'ppe:norms:upsert',
    async (
      _e,
      args: {
        id?: string;
        name: string;
        postTitle?: string | null;
        departmentId?: string | null;
        validFrom?: number;
        validTo?: number | null;
        lines: Array<{ nomenclatureId: string; qty: number; wearMonths: number }>;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
      if (!gate.ok) return gate as Err;
      return toResult(
        await httpAuthed(ctx.sysDb, base(), '/ppe/norms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }),
      );
    },
  );

  ipcMain.handle('ppe:cards:open', async (_e, args: { employeeId: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(
      await httpAuthed(ctx.sysDb, base(), '/ppe/cards/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      }),
    );
  });

  ipcMain.handle('ppe:cards:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/cards/${encodeURIComponent(String(id || ''))}`, { method: 'GET' }));
  });

  ipcMain.handle('ppe:cards:byEmployee', async (_e, employeeId: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(
      await httpAuthed(ctx.sysDb, base(), `/ppe/cards/by-employee/${encodeURIComponent(String(employeeId || ''))}`, { method: 'GET' }),
    );
  });

  ipcMain.handle('ppe:cards:assignNorms', async (_e, args: { cardId: string; normSetIds: string[] }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(
      await httpAuthed(ctx.sysDb, base(), `/ppe/cards/${encodeURIComponent(String(args?.cardId || ''))}/norms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normSetIds: args?.normSetIds ?? [] }),
      }),
    );
  });

  ipcMain.handle('ppe:cards:close', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(
      await httpAuthed(ctx.sysDb, base(), `/ppe/cards/${encodeURIComponent(String(id || ''))}/close`, { method: 'POST' }),
    );
  });

  ipcMain.handle(
    'ppe:cards:issue',
    async (_e, args: { cardId: string; warehouseId: string; docNo?: string; lines: Array<{ nomenclatureId: string; qty: number }> }) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'erp.documents.post');
      if (!gate.ok) return gate as Err;
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/ppe/cards/${encodeURIComponent(String(args?.cardId || ''))}/issue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ warehouseId: args?.warehouseId, docNo: args?.docNo, lines: args?.lines ?? [] }),
        }),
      );
    },
  );
}
