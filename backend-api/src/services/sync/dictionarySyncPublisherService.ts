/**
 * Публикатор словарных зеркал (миграция 0102).
 *
 * erp_counterparties / erp_contracts / directory_engine_brands ведут триггеры
 * EAV-зеркал (0083/0084) — мимо пути записи синхронизации. Такая строка не получает
 * номера журнала, а инкрементальный pull отбирает изменения условием
 * `last_server_seq > since`: в SQL `NULL > n` не TRUE, то есть строка не приезжает
 * клиенту НИКОГДА (тот же разрыв, что закрывают публикаторы складов и аккаунтов).
 *
 * Признак «не опубликовано» несёт сама строка: `sync_status = 'pending'`. Ставят его
 * rebuild-функции, но ТОЛЬКО на реальном изменении зеркалируемых колонок (WHERE-гард
 * 0102, приём users R3) — иначе любая правка любого атрибута сущности рассылала бы
 * строку всему парку. Снимает `applyPushBatch`, когда строка реально записана
 * и проштампована seq.
 *
 * Порядок обхода — контрагенты раньше договоров (FK customer_id): холодный пул
 * применяет таблицы по dependsOn реестра, но публикация идёт построчно, и договор
 * со ссылкой на ещё неопубликованного заказчика чистится FK-сиротами на клиенте.
 *
 * Живёт только на primary (singleton): ledger-append не должен идти с двух инстансов сразу.
 */
import { SyncTableName } from '@matricarmz/shared';
import { ne } from 'drizzle-orm';

import { db } from '../../database/db.js';
import {
  directoryEngineBrands,
  erpContractPaymentSlots,
  erpContractPayments,
  erpContracts,
  erpCounterparties,
  erpEngineCards,
} from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { writeSyncChanges, type SyncWriteInput } from './syncWriteService.js';

const PUBLISH_TICK_MS = 60_000;
/** Три словаря — сотни строк; потолок на таблицу — страховка, а не режим работы. */
const BATCH_LIMIT = 500;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

let running = false;
let timer: NodeJS.Timeout | null = null;

function toInput(
  table: SyncTableName,
  row: Record<string, unknown>,
  map: (r: Record<string, unknown>) => Record<string, unknown>,
): SyncWriteInput {
  const deletedAt = row['deletedAt'] == null ? null : Number(row['deletedAt']);
  return {
    type: deletedAt == null ? 'upsert' : 'delete',
    table,
    row_id: String(row['id']),
    row: map(row),
  };
}

export function toCounterpartyInput(r: Record<string, unknown>): SyncWriteInput {
  return toInput(SyncTableName.ErpCounterparties, r, (row) => ({
    id: String(row['id']),
    name: String(row['name']),
    short_name: row['shortName'] == null ? null : String(row['shortName']),
    inn: row['inn'] == null ? null : String(row['inn']),
    kpp: row['kpp'] == null ? null : String(row['kpp']),
    address: row['address'] == null ? null : String(row['address']),
    email: row['email'] == null ? null : String(row['email']),
    phone: row['phone'] == null ? null : String(row['phone']),
    created_at: Number(row['createdAt']),
    updated_at: Number(row['updatedAt']),
    deleted_at: row['deletedAt'] == null ? null : Number(row['deletedAt']),
  }));
}

export function toContractInput(r: Record<string, unknown>): SyncWriteInput {
  return toInput(SyncTableName.ErpContracts, r, (row) => ({
    id: String(row['id']),
    number: row['number'] == null ? null : String(row['number']),
    internal_number: row['internalNumber'] == null ? null : String(row['internalNumber']),
    goz_name: row['gozName'] == null ? null : String(row['gozName']),
    goz_igk: row['gozIgk'] == null ? null : String(row['gozIgk']),
    goz_separate_account_number:
      row['gozSeparateAccountNumber'] == null ? null : String(row['gozSeparateAccountNumber']),
    goz_separate_account_bank:
      row['gozSeparateAccountBank'] == null ? null : String(row['gozSeparateAccountBank']),
    goz_separate_account:
      row['gozSeparateAccount'] == null ? null : String(row['gozSeparateAccount']),
    signed_at: row['signedAt'] == null ? null : Number(row['signedAt']),
    due_at: row['dueAt'] == null ? null : Number(row['dueAt']),
    customer_id: row['customerId'] == null ? null : String(row['customerId']),
    comment: row['comment'] == null ? null : String(row['comment']),
    sections_json: row['sectionsJson'] == null ? null : String(row['sectionsJson']),
    execution_parts_json:
      row['executionPartsJson'] == null ? null : String(row['executionPartsJson']),
    payments_json: row['paymentsJson'] == null ? null : String(row['paymentsJson']),
    created_at: Number(row['createdAt']),
    updated_at: Number(row['updatedAt']),
    deleted_at: row['deletedAt'] == null ? null : Number(row['deletedAt']),
  }));
}

export function toEngineBrandInput(r: Record<string, unknown>): SyncWriteInput {
  return toInput(SyncTableName.DirectoryEngineBrands, r, (row) => ({
    id: String(row['id']),
    name: String(row['name']),
    is_active: Boolean(row['isActive']),
    metadata_json: row['metadataJson'] == null ? null : String(row['metadataJson']),
    deprecated_at: row['deprecatedAt'] == null ? null : Number(row['deprecatedAt']),
    created_at: Number(row['createdAt']),
    updated_at: Number(row['updatedAt']),
    deleted_at: row['deletedAt'] == null ? null : Number(row['deletedAt']),
  }));
}

export function toPaymentSlotInput(r: Record<string, unknown>): SyncWriteInput {
  return toInput(SyncTableName.ErpContractPaymentSlots, r, (row) => ({
    id: String(row['id']),
    contract_id: String(row['contractId']),
    section_key: String(row['sectionKey']),
    engine_brand_id: row['engineBrandId'] == null ? null : String(row['engineBrandId']),
    engine_id: row['engineId'] == null ? null : String(row['engineId']),
    contract_price_kop: row['contractPriceKop'] == null ? null : Number(row['contractPriceKop']),
    created_at: Number(row['createdAt']),
    updated_at: Number(row['updatedAt']),
    deleted_at: row['deletedAt'] == null ? null : Number(row['deletedAt']),
  }));
}

export function toPaymentInput(r: Record<string, unknown>): SyncWriteInput {
  return toInput(SyncTableName.ErpContractPaymentPayments, r, (row) => ({
    id: String(row['id']),
    slot_id: String(row['slotId']),
    date: String(row['date']),
    amount_kop: Number(row['amountKop']),
    kind: String(row['kind']),
    note: row['note'] == null ? null : String(row['note']),
    countdown_start: row['countdownStart'] == null ? null : Boolean(row['countdownStart']),
    created_at: Number(row['createdAt']),
    updated_at: Number(row['updatedAt']),
    deleted_at: row['deletedAt'] == null ? null : Number(row['deletedAt']),
  }));
}

const textOrNullIn = (row: Record<string, unknown>, key: string): string | null => {
  const v = row[key];
  return v == null || v === '' ? null : String(v);
};
const msOrNullIn = (row: Record<string, unknown>, key: string): number | null => {
  const v = row[key];
  return v == null ? null : Number(v);
};
const uuidOrNullIn = (row: Record<string, unknown>, key: string): string | null => {
  const v = row[key];
  return v == null ? null : String(v);
};

export function toEngineCardInput(r: Record<string, unknown>): SyncWriteInput {
  return toInput(SyncTableName.ErpEngineCards, r, (row) => ({
    id: String(row['id']),
    engine_number: textOrNullIn(row, 'engineNumber'),
    engine_internal_number: textOrNullIn(row, 'engineInternalNumber'),
    engine_internal_number_year: msOrNullIn(row, 'engineInternalNumberYear'),
    engine_brand_id: uuidOrNullIn(row, 'engineBrandId'),
    engine_brand: textOrNullIn(row, 'engineBrand'),
    arrival_date: msOrNullIn(row, 'arrivalDate'),
    customer_id: uuidOrNullIn(row, 'customerId'),
    contract_id: uuidOrNullIn(row, 'contractId'),
    contract_section_number: textOrNullIn(row, 'contractSectionNumber'),
    workshop_id: uuidOrNullIn(row, 'workshopId'),
    status_rework_sent: Boolean(row['statusReworkSent']),
    status_rework_sent_date: msOrNullIn(row, 'statusReworkSentDate'),
    status_scrap_confirmed: Boolean(row['statusScrapConfirmed']),
    status_scrap_confirmed_date: msOrNullIn(row, 'statusScrapConfirmedDate'),
    status_repair_started: Boolean(row['statusRepairStarted']),
    status_repair_started_date: msOrNullIn(row, 'statusRepairStartedDate'),
    status_repaired: Boolean(row['statusRepaired']),
    status_repaired_date: msOrNullIn(row, 'statusRepairedDate'),
    status_customer_sent: Boolean(row['statusCustomerSent']),
    status_customer_sent_date: msOrNullIn(row, 'statusCustomerSentDate'),
    status_customer_accepted: Boolean(row['statusCustomerAccepted']),
    status_customer_accepted_date: msOrNullIn(row, 'statusCustomerAcceptedDate'),
    status_storage_received: Boolean(row['statusStorageReceived']),
    status_storage_received_date: msOrNullIn(row, 'statusStorageReceivedDate'),
    status_rejected: Boolean(row['statusRejected']),
    status_rejected_date: msOrNullIn(row, 'statusRejectedDate'),
    scrap_reason: textOrNullIn(row, 'scrapReason'),
    reclamation_flag: Boolean(row['reclamationFlag']),
    reclamation_accepted_date: msOrNullIn(row, 'reclamationAcceptedDate'),
    reclamation_customer_reason: textOrNullIn(row, 'reclamationCustomerReason'),
    reclamation_actual_defect: textOrNullIn(row, 'reclamationActualDefect'),
    reclamation_defect_nature: textOrNullIn(row, 'reclamationDefectNature'),
    reclamation_act_number: textOrNullIn(row, 'reclamationActNumber'),
    reclamation_verdict_date: msOrNullIn(row, 'reclamationVerdictDate'),
    reclamation_shipped_date: msOrNullIn(row, 'reclamationShippedDate'),
    reclamation_comment: textOrNullIn(row, 'reclamationComment'),
    reclamation_verdict: textOrNullIn(row, 'reclamationVerdict'),
    reclamation_repair_status: textOrNullIn(row, 'reclamationRepairStatus'),
    repeat_arrival_flag: Boolean(row['repeatArrivalFlag']),
    number_collision_flag: Boolean(row['numberCollisionFlag']),
    previous_arrival_id: uuidOrNullIn(row, 'previousArrivalId'),
    merged_into: uuidOrNullIn(row, 'mergedInto'),
    arrival_invoice: textOrNullIn(row, 'arrivalInvoice'),
    shipment_invoice: textOrNullIn(row, 'shipmentInvoice'),
    engine_note: textOrNullIn(row, 'engineNote'),
    docs_state: textOrNullIn(row, 'docsState'),
    docs_aspvr_contractor_date: msOrNullIn(row, 'docsAspvrContractorDate'),
    docs_vp_sent_date: msOrNullIn(row, 'docsVpSentDate'),
    docs_vp_returned_date: msOrNullIn(row, 'docsVpReturnedDate'),
    docs_aspvr_customer_scan_date: msOrNullIn(row, 'docsAspvrCustomerScanDate'),
    docs_aspvr_customer_original_date: msOrNullIn(row, 'docsAspvrCustomerOriginalDate'),
    docs_track_or_act: textOrNullIn(row, 'docsTrackOrAct'),
    docs_aspvr_signed_customer_date: msOrNullIn(row, 'docsAspvrSignedCustomerDate'),
    docs_aspvr_customer_received: Boolean(row['docsAspvrCustomerReceived']),
    docs_return_scan_date: msOrNullIn(row, 'docsReturnScanDate'),
    docs_return_original_date: msOrNullIn(row, 'docsReturnOriginalDate'),
    docs_note: textOrNullIn(row, 'docsNote'),
    created_at: Number(row['createdAt']),
    updated_at: Number(row['updatedAt']),
    deleted_at: row['deletedAt'] == null ? null : Number(row['deletedAt']),
  }));
}

/** Один проход: опубликовать строки, помеченные `pending`. Возвращает число опубликованных. */
export async function publishPendingDictionaries(): Promise<number> {
  let total = 0;
  const pending = [
    { table: erpCounterparties, toInput: toCounterpartyInput },
    { table: erpContracts, toInput: toContractInput },
    { table: directoryEngineBrands, toInput: toEngineBrandInput },
    // Слоты/платежи договоров (contract-payments-strict-2026-10): слоты после договоров
    // (FK contract_id), платежи после слотов — тот же приём, что договоры после заказчиков.
    { table: erpContractPaymentSlots, toInput: toPaymentSlotInput },
    { table: erpContractPayments, toInput: toPaymentInput },
    // Карточки двигателей (план engine-cards-strict-2026-10, E3a): ссылки без FK,
    // порядок не важен — в конце, после всех справочников.
    { table: erpEngineCards, toInput: toEngineCardInput },
  ] as const;
  for (const { table, toInput: convert } of pending) {
    const rows = await db
      .select()
      .from(table)
      .where(ne(table.syncStatus, 'synced'))
      .limit(BATCH_LIMIT);
    if (rows.length === 0) continue;
    const inputs = (rows as Array<Record<string, unknown>>).map(convert);
    await writeSyncChanges(inputs, SYSTEM_ACTOR, { allowSyncConflicts: true });
    total += inputs.length;
  }
  return total;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const total = await publishPendingDictionaries();
    if (total > 0) logInfo('dictionaries published', { rows: total });
  } catch (e) {
    logError('dictionaries publish failed', { error: String(e) });
  } finally {
    running = false;
  }
}

export function startDictionarySyncPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PUBLISH_TICK_MS);
  timer.unref?.();
  void tick();
  logInfo('dictionary sync publisher started', { tickMs: PUBLISH_TICK_MS });
}

export function stopDictionarySyncPublisher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
