import { and, asc, eq, isNull } from 'drizzle-orm';
import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';
import { erpEngineReclamations } from '../../database/schema.js';
import { httpAuthed } from '../../services/httpClient.js';
import { syncEngineReclamationMirror } from '../../services/engineReclamationMirror.js';
import { syncEngineReclamationStages } from '../../services/engineReclamationStages.js';
import { loadRepairStageTemplates } from '../../services/repairStageService.js';

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

/** Что сделала материализация приёмки по рекламации в истории ремонта. */
export type EngineReclamationStagesSummary = {
  created: number;
  updated: number;
  removed: number;
  errors: string[];
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
    async (_e, engineId: string): Promise<Result<{ rows: EngineReclamationDto[]; source: 'server' | 'replica' }>> => {
      const id = String(engineId ?? '');
      // СЕРВЕР — источник правды по очереди. Локальная реплика отстаёт на минуты, и
      // пустой ответ неё выглядел как «рекламаций нет»: оператор жал «Сохранить очередь»
      // с пустой формой — а серверная дверь честно применяла «заменить очередь» и СМЯГКО
      // УДАЛЯЛА рекламацию (жалоба владельца 11.11.2026, Е02АТ5382: три нажатия — три
      // строки, две удалены). Поэтому читаем сервер, а реплику берём офлайн-фолбэком.
      try {
        const res = await httpAuthed(ctx.sysDb, base(), `/engine-reclamations/${encodeURIComponent(id)}`, {
          method: 'GET',
        });
        if (res.ok) {
          const json = res.json as { ok?: boolean; rows?: EngineReclamationDto[] } | null;
          if (json?.ok === true && Array.isArray(json.rows)) {
            return { ok: true, rows: json.rows, source: 'server' };
          }
        }
      } catch {
        /* нет связи — берём локальную реплику */
      }
      try {
        const db = ctx.dataDb();
        const rows = await db
          .select()
          .from(erpEngineReclamations)
          .where(and(eq(erpEngineReclamations.engineId, id), isNull(erpEngineReclamations.deletedAt)))
          .orderBy(asc(erpEngineReclamations.queueNo));
        return {
          ok: true,
          source: 'replica',
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
        /**
         * Подтверждение очистки: пустая очередь без этого флага НЕ удаляет рекламацию на
         * сервере (жалоба владельца 11.11.2026, Е02АТ5382 — клиент с отставшей репликой
         * прислал пустую очередь и снёс запись, которую только что записал).
         */
        clear?: boolean;
        /**
         * Что клиент видел при загрузке очереди: снимать можно только эти строки —
         * иначе сохранение устаревшей формы снесло бы чужую рекламацию.
         */
        knownIds?: string[];
      },
    ): Promise<Result<{ count: number; rows: EngineReclamationDto[]; cleared?: boolean; stages?: EngineReclamationStagesSummary }>> => {
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
          clear: args?.clear === true,
          knownIds: Array.isArray(args?.knownIds) ? args.knownIds : [],
        }),
      });
      if (!res.ok) return toResult(res);
      const saved = (res.json as { rows?: EngineReclamationDto[] } | undefined)?.rows ?? [];
      // Зеркало текущей рекламации в EAV — для клиентов прежней версии (они читают
      // признак и даты из EAV) и для серверной проекции карточки с ИИ-инструментами.
      // Раньше зеркало копилось только при сохранении карточки, поэтому «Сохранить
      // очередь» двигал очередь и ни одного отчёта: признака рекламации не было ни
      // в списке, ни в отчётах, ни в ведомостях.
      const mirrorErrors = await syncEngineReclamationMirror(
        ctx.dataDb(),
        engineId,
        saved.map((row) => ({
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
      // Приёмка по рекламации — этап истории ремонта (владелец 11.11.2026: приход по
      // рекламации приравнивается к приёмке двигателя на заводе). Материализуем её
      // здесь же, пока очередь свежа: очередь — источник правды, этап — её след.
      // Право на этап — как у карточки (`work_sheets.edit` ИЛИ `operations.edit`): без
      // него этап не пишется, но очередь уже принята сервером — молчать об отказе нельзя.
      const stageSummary = await materializeReclamationStages(ctx, engineId, saved);
      if (stageSummary.errors.length > 0) {
        ctx.logToFile(`[engine-reclamations] этапы приёмки по рекламации: ${stageSummary.errors.join('; ')}`);
      }
      // Добор pull'а: очередь — источник правды, а она приезжает журналом. Без добора
      // синяя метка в списке и отчёты появлялись бы только на следующем круге синка.
      void ctx.mgr.runOnce().catch(() => undefined);
      const out = toResult<{ count: number; rows: EngineReclamationDto[]; stages?: EngineReclamationStagesSummary }>(res);
      if (!out.ok) return out;
      return { ...out, stages: stageSummary };
    },
  );
}

/**
 * Материализация приёмки по рекламации в истории ремонта.
 *
 * Отказ здесь не отменяет сохранение очереди: очередь на сервере уже принята, а этап —
 * её след в истории. Отказ возвращается списком, чтобы вкладка показала его оператору.
 */
async function materializeReclamationStages(
  ctx: IpcContext,
  engineId: string,
  rows: EngineReclamationDto[],
): Promise<EngineReclamationStagesSummary> {
  const empty: EngineReclamationStagesSummary = { created: 0, updated: 0, removed: 0, errors: [] };
  try {
    const perms = await ctx.currentPermissions();
    const canWriteStageRow = perms['work_sheets.edit'] === true || perms['operations.edit'] === true;
    if (!canWriteStageRow) {
      return { ...empty, errors: ['Нет права писать этапы ремонта — приёмка по рекламации не попала в историю.'] };
    }
    const templates = await loadRepairStageTemplates(ctx.sysDb, ctx.mgr.getApiBaseUrl());
    const actor = (await ctx.currentActor().catch(() => undefined)) ?? 'local';
    return await syncEngineReclamationStages(ctx.dataDb(), engineId, rows, actor, templates.templates);
  } catch (e) {
    return { ...empty, errors: [String(e)] };
  }
}
