import { ipcMain } from 'electron';
import { eq } from 'drizzle-orm';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';
import { erpEngineCards } from '../../database/schema.js';

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
      const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const txt = (v: unknown): string | null => (typeof v === 'string' ? v : null);
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
        },
      };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}
