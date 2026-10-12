import { isNull } from 'drizzle-orm';
import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';
import { signatureDefaults } from '../../database/schema.js';
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

export type SignatureDefaultDto = { fieldKey: string; employeeId: string | null };

/**
 * Умолчания подписей (PR-5) живут в pull-only реплике `signature_defaults`
 * (владение server): чтение — из локальной SQLite (офлайн-подстановка в актах),
 * запись — только админской дверью REST `/signature-defaults` (роль проверяет
 * сервер; клиентский push в таблицу закрыт backstop'ом).
 */
export function registerSignatureDefaultsIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle('signatureDefaults:list', async (): Promise<Result<{ rows: SignatureDefaultDto[] }>> => {
    try {
      const rows = await ctx
        .dataDb()
        .select({ fieldKey: signatureDefaults.fieldKey, employeeId: signatureDefaults.employeeId })
        .from(signatureDefaults)
        .where(isNull(signatureDefaults.deletedAt));
      return {
        ok: true,
        rows: rows.map((r) => ({ fieldKey: String(r.fieldKey), employeeId: r.employeeId == null ? null : String(r.employeeId) })),
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle(
    'signatureDefaults:set',
    async (_e, args: { fieldKey: string; employeeId: string | null }): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      return toResult(
        await httpAuthed(ctx.sysDb, base(), '/signature-defaults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fieldKey: args?.fieldKey ?? '', employeeId: args?.employeeId ?? null }),
        }),
      );
    },
  );
}
