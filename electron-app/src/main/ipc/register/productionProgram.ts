import { and, asc, inArray, isNull } from 'drizzle-orm';
import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';
import { erpProductionProgramRows, erpProductionPrograms } from '../../database/schema.js';
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

export type ProductionProgramDto = {
  id: string;
  periodStart: number;
  periodEnd: number;
  shop: string;
  title: string;
  status: string;
  signatureSlots: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type ProductionProgramLineDto = {
  id: string;
  programId: string;
  orderNo: number;
  contractId: string | null;
  groupLabel: string;
  contractKind: string | null;
  engineId: string | null;
  engineMark: string;
  engineNumber: string;
  state: string | null;
  shippingPlanAt: number | null;
  factors: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/**
 * Производственная программа (ПП) — клиентский контур.
 *
 * План живёт в pull-only реплике (`erp_production_programs` /
 * `erp_production_program_rows`, владение server): чтение — из локальной SQLite,
 * чтобы план был доступен и без сети. Запись — только серверной дверью REST
 * `/production-program` (права `production_program.view` / `.edit` проверяет
 * сервер; клиентский push в эти таблицы закрыт backstop'ом).
 */
export function registerProductionProgramIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle(
    'productionProgram:list',
    async (): Promise<Result<{ rows: ProductionProgramDto[]; lines: ProductionProgramLineDto[] }>> => {
      try {
        const db = ctx.dataDb();
        const programs = await db
          .select()
          .from(erpProductionPrograms)
          .where(isNull(erpProductionPrograms.deletedAt))
          .orderBy(asc(erpProductionPrograms.periodStart), asc(erpProductionPrograms.createdAt));
        const ids = programs.map((p) => String(p.id));
        const lines =
          ids.length === 0
            ? []
            : await db
                .select()
                .from(erpProductionProgramRows)
                .where(
                  and(
                    inArray(erpProductionProgramRows.programId, ids as any),
                    isNull(erpProductionProgramRows.deletedAt),
                  ),
                )
                .orderBy(asc(erpProductionProgramRows.orderNo));
        return {
          ok: true,
          rows: programs.map((p) => ({
            id: String(p.id),
            periodStart: Number(p.periodStart),
            periodEnd: Number(p.periodEnd),
            shop: String(p.shop),
            title: String(p.title),
            status: String(p.status),
            signatureSlots: p.signatureSlots == null ? null : String(p.signatureSlots),
            createdAt: Number(p.createdAt),
            updatedAt: Number(p.updatedAt),
            deletedAt: p.deletedAt == null ? null : Number(p.deletedAt),
          })),
          lines: lines.map((r) => ({
            id: String(r.id),
            programId: String(r.programId),
            orderNo: Number(r.orderNo),
            contractId: r.contractId == null ? null : String(r.contractId),
            groupLabel: String(r.groupLabel),
            contractKind: r.contractKind == null ? null : String(r.contractKind),
            engineId: r.engineId == null ? null : String(r.engineId),
            engineMark: String(r.engineMark),
            engineNumber: String(r.engineNumber),
            state: r.state == null ? null : String(r.state),
            shippingPlanAt: r.shippingPlanAt == null ? null : Number(r.shippingPlanAt),
            factors: String(r.factors),
            note: String(r.note),
            createdAt: Number(r.createdAt),
            updatedAt: Number(r.updatedAt),
            deletedAt: r.deletedAt == null ? null : Number(r.deletedAt),
          })),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  ipcMain.handle(
    'productionProgram:create',
    async (
      _e,
      args: {
        periodStart: number;
        periodEnd: number;
        shop: string;
        title: string;
        status?: string;
        signatureSlots?: string | null;
      },
    ): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      return toResult(
        await httpAuthed(ctx.sysDb, base(), '/production-program', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args ?? {}),
        }),
      );
    },
  );

  ipcMain.handle(
    'productionProgram:update',
    async (
      _e,
      args: {
        id: string;
        periodStart?: number;
        periodEnd?: number;
        shop?: string;
        title?: string;
        status?: string;
        signatureSlots?: string | null;
      },
    ): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const { id, ...rest } = args ?? ({} as { id: string });
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/production-program/${encodeURIComponent(String(id ?? ''))}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rest),
        }),
      );
    },
  );

  ipcMain.handle(
    'productionProgram:saveRows',
    async (
      _e,
      args: {
        id: string;
        rows: Array<{
          id?: string | null;
          orderNo: number;
          contractId?: string | null;
          groupLabel: string;
          contractKind?: string | null;
          engineId?: string | null;
          engineMark?: string;
          engineNumber?: string;
          state?: string | null;
          shippingPlanAt?: number | null;
          factors?: string;
          note?: string;
        }>;
      },
    ): Promise<Result<{ count: number }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const id = String(args?.id ?? '');
      const rows = Array.isArray(args?.rows) ? args.rows : [];
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/production-program/${encodeURIComponent(id)}/rows`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows }),
        }),
      );
    },
  );

  ipcMain.handle(
    'productionProgram:remove',
    async (_e, id: string): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/production-program/${encodeURIComponent(String(id ?? ''))}`, {
          method: 'DELETE',
        }),
      );
    },
  );
}
