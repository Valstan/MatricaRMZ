import { ipcMain } from 'electron';
import { eq } from 'drizzle-orm';

import { engineInternalNumberDuplicateMessage, engineInternalNumberKey, normalizeLookupCompact } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { erpEngineCards } from '../../database/schema.js';
import {
  engineHasDuplicateBypassFlag,
  ensureEngineRow,
  findEngineDuplicateByNumber,
  findEngineInternalNumberDuplicate,
  getEngineAttrDefs,
} from '../../services/engineService.js';
import {
  isKnownEngineCardCode,
  readEngineCardStrict,
  saveEngineCardStrict,
} from '../../services/engineCardsReplica.js';
import { ensureRepairStageRow } from '../../services/repairStageService.js';

type Err = { ok: false; error: string };

/**
 * Карточки двигателей — строгая реплика (план engine-cards-strict-2026-10, E3a).
 * Чтение — локальная реплика (офлайн работает), EAV-фолбэк решает renderer.
 * Запись — E3b (реплика pending + push); до тех пор пишет старый EAV-путь.
 * Гейт — тот же, что у прежнего чтения карточки (`engines.view`); секция
 * «Производство» — префиксом `engines:`.
 */
export function registerEngineCardsIpc(ctx: IpcContext) {
  ipcMain.handle('engines:card:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'engines.view');
    if (!gate.ok) return gate as Err;
    try {
      const rows = await ctx
        .dataDb()
        .select()
        .from(erpEngineCards)
        .where(eq(erpEngineCards.id, String(id ?? '')))
        .limit(1);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row || row.deletedAt != null) return { ok: true as const, row: null };
      const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);      const txt = (v: unknown): string | null => (typeof v === 'string' ? v : null);
      const flg = (v: unknown): boolean => v === true || v === 1;
      return {
        ok: true as const,
        row: {
          id: String(row.id),
          engine_number: txt(row.engineNumber),
          engine_internal_number: txt(row.engineInternalNumber),
          engine_internal_number_year: num(row.engineInternalNumberYear),
          engine_brand_id: txt(row.engineBrandId),
          engine_brand: txt(row.engineBrand),
          arrival_date: num(row.arrivalDate),
          customer_id: txt(row.customerId),
          contract_id: txt(row.contractId),
          contract_section_number: txt(row.contractSectionNumber),
          workshop_id: txt(row.workshopId),
          status_rework_sent: flg(row.statusReworkSent),
          status_rework_sent_date: num(row.statusReworkSentDate),
          status_scrap_confirmed: flg(row.statusScrapConfirmed),
          status_scrap_confirmed_date: num(row.statusScrapConfirmedDate),
          status_repair_started: flg(row.statusRepairStarted),
          status_repair_started_date: num(row.statusRepairStartedDate),
          status_repaired: flg(row.statusRepaired),
          status_repaired_date: num(row.statusRepairedDate),
          status_customer_sent: flg(row.statusCustomerSent),
          status_customer_sent_date: num(row.statusCustomerSentDate),
          status_customer_accepted: flg(row.statusCustomerAccepted),
          status_customer_accepted_date: num(row.statusCustomerAcceptedDate),
          status_storage_received: flg(row.statusStorageReceived),
          status_storage_received_date: num(row.statusStorageReceivedDate),
          status_rejected: flg(row.statusRejected),
          status_rejected_date: num(row.statusRejectedDate),
          scrap_reason: txt(row.scrapReason),
          reclamation_flag: flg(row.reclamationFlag),
          reclamation_accepted_date: num(row.reclamationAcceptedDate),
          reclamation_customer_reason: txt(row.reclamationCustomerReason),
          reclamation_actual_defect: txt(row.reclamationActualDefect),
          reclamation_defect_nature: txt(row.reclamationDefectNature),
          reclamation_act_number: txt(row.reclamationActNumber),
          reclamation_verdict_date: num(row.reclamationVerdictDate),
          reclamation_shipped_date: num(row.reclamationShippedDate),
          reclamation_comment: txt(row.reclamationComment),
          reclamation_verdict: txt(row.reclamationVerdict),
          reclamation_repair_status: txt(row.reclamationRepairStatus),
          repeat_arrival_flag: flg(row.repeatArrivalFlag),
          number_collision_flag: flg(row.numberCollisionFlag),
          previous_arrival_id: txt(row.previousArrivalId),
          merged_into: txt(row.mergedInto),
          arrival_invoice: txt(row.arrivalInvoice),
          shipment_invoice: txt(row.shipmentInvoice),
          engine_note: txt(row.engineNote),
          docs_state: txt(row.docsState),
          docs_aspvr_contractor_date: num(row.docsAspvrContractorDate),
          docs_vp_sent_date: num(row.docsVpSentDate),
          docs_vp_returned_date: num(row.docsVpReturnedDate),
          docs_aspvr_customer_scan_date: num(row.docsAspvrCustomerScanDate),
          docs_aspvr_customer_original_date: num(row.docsAspvrCustomerOriginalDate),
          docs_track_or_act: txt(row.docsTrackOrAct),
          docs_aspvr_signed_customer_date: num(row.docsAspvrSignedCustomerDate),
          docs_aspvr_customer_received: flg(row.docsAspvrCustomerReceived),
          docs_return_scan_date: num(row.docsReturnScanDate),
          docs_return_original_date: num(row.docsReturnOriginalDate),
          docs_note: txt(row.docsNote),
          updated_at: Number(row.updatedAt ?? 0),
          sync_status: String((row as { syncStatus?: unknown }).syncStatus ?? 'synced'),
        },
      };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  /**
   * Запись карточки (E3b): клиентские гейты дублей + локальная реплика pending.
   * Уход в push забирает collectPending; подтверждение — pull'ом. Гейты читают
   * локальные EAV (с лагом pull'а после E3b) — гонки ловит серверная pre-sign
   * партиция, отбитая строка гасится в error и показывается баннером.
   */
  ipcMain.handle('engines:card:save', async (_e, args: { id: string; fields: Record<string, unknown> }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate as Err;
    try {
      const id = String(args?.id ?? '').trim();
      if (!id) return { ok: false as const, error: 'пустой id двигателя' };
      const fields = (args?.fields ?? {}) as Record<string, unknown>;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        return { ok: false as const, error: 'ожидался объект полей карточки' };
      }
      const bad = Object.keys(fields).filter((k) => !isKnownEngineCardCode(k));
      if (bad.length > 0) return { ok: false as const, error: `неизвестные поля карточки двигателя: ${bad.join(', ')}` };
      const db = ctx.dataDb();
      const replica = await readEngineCardStrict(db, id);
      if (fields.engine_number !== undefined && fields.engine_number !== null) {
        const next = String(fields.engine_number ?? '');
        const key = normalizeLookupCompact(next);
        if (key) {
          const dup = await findEngineDuplicateByNumber(db, next, id);
          if (dup) {
            const explicit =
              fields.repeat_arrival_flag !== undefined || fields.number_collision_flag !== undefined;
            const bypass = explicit
              ? fields.repeat_arrival_flag === true || fields.number_collision_flag === true
              : Boolean(replica?.repeatArrivalFlag || replica?.numberCollisionFlag) ||
                (await engineHasDuplicateBypassFlag(db, id, await getEngineAttrDefs(db)));
            if (!bypass) {
              return {
                ok: false as const,
                error: `Двигатель с номером «${dup.engineNumber}» уже существует. Откройте его карточку вместо создания дубля.`,
              };
            }
          }
        }
      }
      if (fields.engine_internal_number !== undefined || fields.engine_internal_number_year !== undefined) {
        const rep = replica as Record<string, unknown> | null;
        const num =
          fields.engine_internal_number !== undefined && fields.engine_internal_number !== null
            ? String(fields.engine_internal_number ?? '')
            : rep?.engineInternalNumber != null
              ? String(rep.engineInternalNumber)
              : null;
        const year =
          fields.engine_internal_number_year !== undefined && fields.engine_internal_number_year !== null
            ? (fields.engine_internal_number_year as number)
            : (rep?.engineInternalNumberYear as number | null) ?? null;
        if (num !== null) {
          const key = engineInternalNumberKey(num, year);
          if (key) {
            const dup = await findEngineInternalNumberDuplicate(db, num, year, id);
            if (dup) return { ok: false as const, error: engineInternalNumberDuplicateMessage(dup) };
          }
        }
      }
      // Deferred-create (как setAttr): сущность материализуется первой реальной
      // записью — брошенная пустая карточка призрака не оставляет. Строго после
      // гейтов: отбитая запись не должна создавать сущность.
      await ensureEngineRow(db, id, Date.now(), await ctx.currentActor());
      const saved = await saveEngineCardStrict(db, id, fields, Date.now());
      // Даты «Основного» — в этапы единого списка (таблица 05.10.2026). В main, а не
      // в рендерере: там запись шла через `workSheets:stages:save` под правом
      // `work_sheets.edit` (поимённое, у производственных ролей его нет) — дату
      // сохраняли, а этап молча не появлялся (замер 07.10: 70 записей от инженера
      // за утро без единого этапа). Здесь гейт уже взят выше — `engines.edit`,
      // а авто-метки — тот же класс, что arrival/sborka/obkatka (их пишут main-сервисы).
      // На сервере строку этапа примет дизъюнкция `work_sheets.edit` ИЛИ
      // `operations.edit` (ledgerAuthz); роль без обоих прав (technolog) строку не
      // получит — сверяемся заранее, чтобы не создавать её в реплике и не гонять
      // отклонённый push. Даты берём из СВЕЖЕЙ строки реплики, а не из присланных
      // полей: тогда любой сейв карточки долечивает недостающий этап, даже если саму
      // дату не трогали (иначе 78 старых движков ждали бы ручной правки даты).
      // Тот же mark-if-absent, что у EAV-пути (`setEngineAttribute`): идемпотентно,
      // дату существующей строки правит только «История ремонта». Best-effort:
      // карточка уже сохранена.
      const stageWritePerms = await ctx.currentPermissions();
      const canWriteStageRow =
        stageWritePerms['work_sheets.edit'] === true || stageWritePerms['operations.edit'] === true;
      if (canWriteStageRow) {
        const fresh = await readEngineCardStrict(db, id);
        const actor = (await ctx.currentActor()) || 'local';
        const stageFromDate = async (code: string, raw: unknown): Promise<void> => {
          if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return;
          try {
            await ensureRepairStageRow(db, id, code, Math.trunc(raw), actor);
          } catch {
            /* авто-метка — не причина терять карточку */
          }
        };
        await stageFromDate('arrival', fresh?.arrivalDate);
        await stageFromDate('shipped', fresh?.statusCustomerSentDate);
        await stageFromDate('accepted', fresh?.statusCustomerAcceptedDate);
      }
      return { ok: true as const, changed: saved.changed };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}
