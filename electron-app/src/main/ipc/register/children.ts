import { asc, isNull } from 'drizzle-orm';
import { ipcMain } from 'electron';

import type { ChildDto, ChildSaveDto } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';
import { erpEmployeeChildren } from '../../database/schema.js';
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
 * Детский модуль — клиентский контур.
 *
 * Карточки детей живут в pull-only реплике (`erp_employee_children`, владение server):
 * чтение — из локальной SQLite, чтобы список детей был доступен и без сети. Запись —
 * только серверной дверью REST `/children` (права `children.view` / `.edit` проверяет
 * сервер; клиентский push в эту таблицу закрыт backstop'ом).
 */
export function registerChildrenIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle(
    'children:list',
    async (): Promise<Result<{ rows: ChildDto[] }>> => {
      try {
        const db = ctx.dataDb();
        const rows = await db
          .select()
          .from(erpEmployeeChildren)
          .where(isNull(erpEmployeeChildren.deletedAt))
          .orderBy(asc(erpEmployeeChildren.fullName));
        return {
          ok: true,
          rows: rows.map((r) => ({
            id: String(r.id),
            employeeId: r.employeeId == null ? null : String(r.employeeId),
            fullName: String(r.fullName),
            birthDate: r.birthDate == null ? null : Number(r.birthDate),
            gender: String(r.gender ?? ''),
            tagsJson: r.tagsJson == null ? null : String(r.tagsJson),
            note: String(r.note ?? ''),
            createdAt: Number(r.createdAt),
            updatedAt: Number(r.updatedAt),
          })),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  ipcMain.handle(
    'children:save',
    async (_e, args: ChildSaveDto & { id?: string | null }): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const id = String(args?.id ?? '').trim();
      const body: Record<string, unknown> = {
        employeeId: args?.employeeId ?? null,
        fullName: args?.fullName ?? '',
        birthDate: args?.birthDate ?? null,
        gender: args?.gender ?? null,
        tags: args?.tags ?? [],
        note: args?.note ?? null,
      };
      return toResult(
        await httpAuthed(ctx.sysDb, base(), id ? `/children/${id}` : '/children', {
          method: id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    },
  );

  ipcMain.handle(
    'children:remove',
    async (_e, id: string): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/children/${String(id ?? '')}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  );
}
