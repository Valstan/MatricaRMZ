import { and, asc, eq, isNull } from 'drizzle-orm';
import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';
import { erpEngineReclamations } from '../../database/schema.js';
import { httpAuthed } from '../../services/httpClient.js';
import { syncEngineReclamationMirror } from '../../services/engineReclamationMirror.js';

/**
 * Рекламации двигателя — клиентский контур.
 *
 * Очередь заездов по рекламации живёт в pull-only реплике
 * (`erp_engine_reclamations`, владение server): чтение — из локальной SQLite,
 * чтобы очередь была видна и без сети. Запись — только серверной дверью REST
 * `/engine-reclamations` (права `engines.view` / `engines.edit` проверяет сервер).
 */

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export type EngineReclamationDto = {
  id: string;
  engineId: string;
  queueNo: number;
  acceptedAt: number | null;
  shippedAt: number | null;
  customerReason: string | null;
  actualDefect: string | null;
  defectNature: string | null;
  actNumber: string | null;
  actDate: number | null;
  comment: string | null;
};

function toResult<T>(r: { ok: boolean; status: number; json?: unknown; text?: string }): Result<T> {
  if (r.ok && r.json && typeof r.json === 'object') return r.json as Result<T>;
  if (r.ok) return { ok: true } as Ok<T>;
  const errPayload = r.json as { error?: unknown } | null;
  const msg = (errPayload && typeof errPayload.error === 'string' ? errPayload.error : r.text) || `HTTP ${r.status}`;
  return { ok: false, error: String(msg) };
}

export function registerEngineReclamationsIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle(
    'engineReclamations:list',
    async (_e, engineId: string): Promise<Result<{ rows: EngineReclamationDto[] }>> => {
      try {
        const db = ctx.dataDb();
        const rows = await db
          .select()
          .from(erpEngineReclamations)
          .where(and(eq(erpEngineReclamations.engineId, String(engineId ?? '')), isNull(erpEngineReclamations.deletedAt)))
          .orderBy(asc(erpEngineReclamations.queueNo));
        return {
          ok: true,
          rows: rows.map((r) => ({
            id: String(r.id),
            engineId: String(r.engineId),
            queueNo: Number(r.queueNo),
            acceptedAt: r.acceptedAt == null ? null : Number(r.acceptedAt),
            shippedAt: r.shippedAt == null ? null : Number(r.shippedAt),
            customerReason: r.customerReason == null ? null : String(r.customerReason),
            actualDefect: r.actualDefect == null ? null : String(r.actualDefect),
            defectNature: r.defectNature == null ? null : String(r.defectNature),
            actNumber: r.actNumber == null ? null : String(r.actNumber),
            actDate: r.actDate == null ? null : Number(r.actDate),
            comment: r.comment == null ? null : String(r.comment),
          })),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  ipcMain.handle(
    'engineReclamations:save',
    async (
      _e,
      args: {
        engineId: string;
        rows: Array<{
          id?: string | null;
          queueNo: number;
          acceptedAt?: number | null;
          shippedAt?: number | null;
          customerReason?: string | null;
          actualDefect?: string | null;
          defectNature?: string | null;
          actNumber?: string | null;
          actDate?: number | null;
          comment?: string | null;
        }>;
        /** Даты основного цикла — для гейта «заезды не пересекаются». */
        mainArrivalDate?: number | null;
        mainShippingDate?: number | null;
      },
    ): Promise<Result<{ count: number }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const engineId = String(args?.engineId ?? '');
      const rows = Array.isArray(args?.rows) ? args.rows : [];
      const res = await httpAuthed(ctx.sysDb, base(), `/engine-reclamations/${encodeURIComponent(engineId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows,
          mainArrivalDate: args?.mainArrivalDate ?? null,
          mainShippingDate: args?.mainShippingDate ?? null,
        }),
      });
      if (!res.ok) return toResult(res);
      // Зеркало текущей рекламации в EAV — для клиентов прежней версии (они читают
      // признак и даты из EAV) и для серверной проекции карточки с ИИ-инструментами.
      // Раньше зеркало копилось только при сохранении карточки, поэтому «Сохранить
      // очередь» двигал очередь и ни одного отчёта: признака рекламации не было ни
      // в списке, ни в отчётах, ни в ведомостях.
      const mirrorErrors = await syncEngineReclamationMirror(
        ctx.dataDb(),
        engineId,
        rows.map((row) => ({
          queueNo: Number(row.queueNo ?? 0),
          acceptedAt: row.acceptedAt ?? null,
          shippedAt: row.shippedAt ?? null,
          customerReason: row.customerReason ?? null,
          actualDefect: row.actualDefect ?? null,
          defectNature: row.defectNature ?? null,
          actNumber: row.actNumber ?? null,
          actDate: row.actDate ?? null,
          comment: row.comment ?? null,
        })),
        await ctx.currentActor().catch(() => undefined),
      );
      if (mirrorErrors.length > 0) {
        ctx.logToFile(`[engine-reclamations] зеркало EAV записано не полностью: ${mirrorErrors.join('; ')}`);
      }
      // Добор pull'а: очередь — источник правды, а она приезжает журналом. Без добора
      // синяя метка в списке и отчёты появлялись бы только на следующем круге синка.
      void ctx.mgr.runOnce().catch(() => undefined);
      return toResult(res);
    },
  );
}
