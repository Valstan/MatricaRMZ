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
 * Приказы о ценах на услуги живут только на сервере (REST `/service-pricing/*`), в реплику не
 * синхронизируются: это редкий документ администратора, а не рабочий поток оператора.
 * Права те же, что у справочников ERP: смотреть — `erp.dictionary.view`, править — `.edit`.
 */
export function registerServicePricingIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle('servicePricing:orders:list', async (_e, args?: { status?: string }) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    const qs = args?.status ? `?status=${encodeURIComponent(args.status)}` : '';
    return toResult(await httpAuthed(ctx.sysDb, base(), `/service-pricing/orders${qs}`, { method: 'GET' }));
  });

  ipcMain.handle(
    'servicePricing:orders:upsert',
    async (
      _e,
      args: {
        id?: string;
        orderNumber: string;
        orderDate: number;
        title: string;
        notes?: string | null;
        documentLink?: string | null;
        issuedByEmployeeId?: string | null;
        effectiveFrom: number;
        status?: string;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
      if (!gate.ok) return gate as Err;
      return toResult(
        await httpAuthed(ctx.sysDb, base(), '/service-pricing/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }),
      );
    },
  );

  ipcMain.handle('servicePricing:orders:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/service-pricing/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  });

  ipcMain.handle('servicePricing:history:list', async (_e, args?: { orderId?: string; nomenclatureId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    const qs: string[] = [];
    if (args?.orderId) qs.push(`orderId=${encodeURIComponent(args.orderId)}`);
    if (args?.nomenclatureId) qs.push(`nomenclatureId=${encodeURIComponent(args.nomenclatureId)}`);
    const url = qs.length ? `/service-pricing/history?${qs.join('&')}` : '/service-pricing/history';
    return toResult(await httpAuthed(ctx.sysDb, base(), url, { method: 'GET' }));
  });

  ipcMain.handle(
    'servicePricing:history:set',
    async (_e, args: { nomenclatureId: string; orderId: string; price: number; effectiveFrom?: number; notes?: string | null }) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
      if (!gate.ok) return gate as Err;
      return toResult(
        await httpAuthed(ctx.sysDb, base(), '/service-pricing/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }),
      );
    },
  );

  ipcMain.handle('servicePricing:history:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/service-pricing/history/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  });

  ipcMain.handle('servicePricing:current', async (_e, nomenclatureId: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(
      await httpAuthed(ctx.sysDb, base(), `/service-pricing/current/${encodeURIComponent(nomenclatureId)}`, { method: 'GET' }),
    );
  });
}
