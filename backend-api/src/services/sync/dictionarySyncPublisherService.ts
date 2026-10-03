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
