import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { attributeDefs, attributeValues, entities, erpEngineCards } from '../database/schema.js';

/**
 * Строгая реплика карточки двигателя (план engine-cards-strict-2026-10, E3b).
 * Клиент пишет локально со статусом pending — уход в push забирает collectPending,
 * подтверждение приезжает pull'ом. Write-through — только серверной строкой
 * (GET после save): сборка полной строки из stale-реплики заткнула бы чужие
 * правки (E3a-план, раздел write-through).
 */

type CardRow = typeof erpEngineCards.$inferSelect;

/** Код атрибута (snake) → колонка drizzle (camel). */
const CODE_TO_COL: Readonly<Record<string, keyof CardRow>> = {
  engine_number: 'engineNumber',
  engine_internal_number: 'engineInternalNumber',
  engine_internal_number_year: 'engineInternalNumberYear',
  engine_brand_id: 'engineBrandId',
  engine_brand: 'engineBrand',
  arrival_date: 'arrivalDate',
  customer_id: 'customerId',
  contract_id: 'contractId',
  contract_section_number: 'contractSectionNumber',
  workshop_id: 'workshopId',
  status_rework_sent: 'statusReworkSent',
  status_rework_sent_date: 'statusReworkSentDate',
  status_scrap_confirmed: 'statusScrapConfirmed',
  status_scrap_confirmed_date: 'statusScrapConfirmedDate',
  status_repair_started: 'statusRepairStarted',
  status_repair_started_date: 'statusRepairStartedDate',
  status_repaired: 'statusRepaired',
  status_repaired_date: 'statusRepairedDate',
  status_customer_sent: 'statusCustomerSent',
  status_customer_sent_date: 'statusCustomerSentDate',
  status_customer_accepted: 'statusCustomerAccepted',
  status_customer_accepted_date: 'statusCustomerAcceptedDate',
  status_storage_received: 'statusStorageReceived',
  status_storage_received_date: 'statusStorageReceivedDate',
  status_rejected: 'statusRejected',
  status_rejected_date: 'statusRejectedDate',
  scrap_reason: 'scrapReason',
  reclamation_flag: 'reclamationFlag',
  reclamation_accepted_date: 'reclamationAcceptedDate',
  reclamation_customer_reason: 'reclamationCustomerReason',
  reclamation_actual_defect: 'reclamationActualDefect',
  reclamation_defect_nature: 'reclamationDefectNature',
  reclamation_act_number: 'reclamationActNumber',
  reclamation_verdict_date: 'reclamationVerdictDate',
  reclamation_shipped_date: 'reclamationShippedDate',
  reclamation_comment: 'reclamationComment',
  reclamation_verdict: 'reclamationVerdict',
  reclamation_repair_status: 'reclamationRepairStatus',
  repeat_arrival_flag: 'repeatArrivalFlag',
  number_collision_flag: 'numberCollisionFlag',
  previous_arrival_id: 'previousArrivalId',
  merged_into: 'mergedInto',
  arrival_invoice: 'arrivalInvoice',
  shipment_invoice: 'shipmentInvoice',
  engine_note: 'engineNote',
  docs_state: 'docsState',
  docs_aspvr_contractor_date: 'docsAspvrContractorDate',
  docs_vp_sent_date: 'docsVpSentDate',
  docs_vp_returned_date: 'docsVpReturnedDate',
  docs_aspvr_customer_scan_date: 'docsAspvrCustomerScanDate',
  docs_aspvr_customer_original_date: 'docsAspvrCustomerOriginalDate',
  docs_track_or_act: 'docsTrackOrAct',
  docs_aspvr_signed_customer_date: 'docsAspvrSignedCustomerDate',
  docs_aspvr_customer_received: 'docsAspvrCustomerReceived',
  docs_return_scan_date: 'docsReturnScanDate',
  docs_return_original_date: 'docsReturnOriginalDate',
  docs_note: 'docsNote',
};

const FLAG_COLS: ReadonlySet<string> = new Set([
  'statusReworkSent',
  'statusScrapConfirmed',
  'statusRepairStarted',
  'statusRepaired',
  'statusCustomerSent',
  'statusCustomerAccepted',
  'statusStorageReceived',
  'statusRejected',
  'reclamationFlag',
  'repeatArrivalFlag',
  'numberCollisionFlag',
  'docsAspvrCustomerReceived',
]);

export function engineCardFieldCount(): number {
  return Object.keys(CODE_TO_COL).length;
}

export function isKnownEngineCardCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CODE_TO_COL, code);
}

/** Строка реплики → snake-ключи карточки (те же txt/num/flg-правила, что отдаёт `card:get`). */
export function strictRowToSnake(row: CardRow): Record<string, unknown> {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const txt = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const flg = (v: unknown): boolean => v === true || v === 1;
  const r = row as unknown as Record<string, unknown>;
  return {
    engine_number: txt(r.engineNumber),
    engine_internal_number: txt(r.engineInternalNumber),
    engine_internal_number_year: num(r.engineInternalNumberYear),
    engine_brand_id: txt(r.engineBrandId),
    engine_brand: txt(r.engineBrand),
    arrival_date: num(r.arrivalDate),
    customer_id: txt(r.customerId),
    contract_id: txt(r.contractId),
    contract_section_number: txt(r.contractSectionNumber),
    workshop_id: txt(r.workshopId),
    status_rework_sent: flg(r.statusReworkSent),
    status_rework_sent_date: num(r.statusReworkSentDate),
    status_scrap_confirmed: flg(r.statusScrapConfirmed),
    status_scrap_confirmed_date: num(r.statusScrapConfirmedDate),
    status_repair_started: flg(r.statusRepairStarted),
    status_repair_started_date: num(r.statusRepairStartedDate),
    status_repaired: flg(r.statusRepaired),
    status_repaired_date: num(r.statusRepairedDate),
    status_customer_sent: flg(r.statusCustomerSent),
    status_customer_sent_date: num(r.statusCustomerSentDate),
    status_customer_accepted: flg(r.statusCustomerAccepted),
    status_customer_accepted_date: num(r.statusCustomerAcceptedDate),
    status_storage_received: flg(r.statusStorageReceived),
    status_storage_received_date: num(r.statusStorageReceivedDate),
    status_rejected: flg(r.statusRejected),
    status_rejected_date: num(r.statusRejectedDate),
    scrap_reason: txt(r.scrapReason),
    reclamation_flag: flg(r.reclamationFlag),
    reclamation_accepted_date: num(r.reclamationAcceptedDate),
    reclamation_customer_reason: txt(r.reclamationCustomerReason),
    reclamation_actual_defect: txt(r.reclamationActualDefect),
    reclamation_defect_nature: txt(r.reclamationDefectNature),
    reclamation_act_number: txt(r.reclamationActNumber),
    reclamation_verdict_date: num(r.reclamationVerdictDate),
    reclamation_shipped_date: num(r.reclamationShippedDate),
    reclamation_comment: txt(r.reclamationComment),
    reclamation_verdict: txt(r.reclamationVerdict),
    reclamation_repair_status: txt(r.reclamationRepairStatus),
    repeat_arrival_flag: flg(r.repeatArrivalFlag),
    number_collision_flag: flg(r.numberCollisionFlag),
    previous_arrival_id: txt(r.previousArrivalId),
    merged_into: txt(r.mergedInto),
    arrival_invoice: txt(r.arrivalInvoice),
    shipment_invoice: txt(r.shipmentInvoice),
    engine_note: txt(r.engineNote),
    docs_state: txt(r.docsState),
    docs_aspvr_contractor_date: num(r.docsAspvrContractorDate),
    docs_vp_sent_date: num(r.docsVpSentDate),
    docs_vp_returned_date: num(r.docsVpReturnedDate),
    docs_aspvr_customer_scan_date: num(r.docsAspvrCustomerScanDate),
    docs_aspvr_customer_original_date: num(r.docsAspvrCustomerOriginalDate),
    docs_track_or_act: txt(r.docsTrackOrAct),
    docs_aspvr_signed_customer_date: num(r.docsAspvrSignedCustomerDate),
    docs_aspvr_customer_received: flg(r.docsAspvrCustomerReceived),
    docs_return_scan_date: num(r.docsReturnScanDate),
    docs_return_original_date: num(r.docsReturnOriginalDate),
    docs_note: txt(r.docsNote),
  };
}

export type EavCardAttr = { value: unknown; updatedAt: number };

/**
 * Слияние строгой реплики поверх EAV для ЧТЕНИЯ (A3).
 *
 * Запись карточки (E3b) идёт только в строгую реплику, а читатели
 * (`getEngineDetails`, `listEngines`) — из EAV. Без слияния свеженаписанное
 * видно лишь после синк-круга (серверный EAV-след возвращается pull'ом):
 * новая карточка после первого сейва выглядит пустой. Правило — посвежее
 * побеждает: поле берётся из реплики, если её updatedAt не старше EAV-строки;
 * EAV-строки нет вовсе (новый двигатель) — всегда из реплики. Снятая реплика
 * (deletedAt) — как нет её.
 */
export function mergeStrictCardAttrs(
  eav: Record<string, EavCardAttr>,
  strict: (CardRow & { syncStatus?: string }) | null,
  strictUpdatedAt: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [code, entry] of Object.entries(eav)) out[code] = entry.value;
  if (!strict || (strict as { deletedAt?: number | null }).deletedAt != null) return out;
  const snake = strictRowToSnake(strict);
  for (const [code, value] of Object.entries(snake)) {
    const entry = eav[code];
    if (!entry || strictUpdatedAt >= entry.updatedAt) out[code] = value;
  }
  return out;
}

export async function readEngineCardStrict(
  db: BetterSQLite3Database,
  id: string,
): Promise<(CardRow & { syncStatus: string }) | null> {
  const rows = (await db.select().from(erpEngineCards).where(eq(erpEngineCards.id, String(id ?? ''))).limit(1)) as Array<
    CardRow & { syncStatus: string }
  >;
  const row = rows[0];
  if (!row || (row as { deletedAt?: number | null }).deletedAt != null) return null;
  return row;
}

/**
 * EAV-база полной строки (snake-ключи): локальные атрибуты той же карточки.
 * Нужна как подложка под запись в реплику, когда реплики нет или она partial:
 * push везёт ПОЛНУЮ строку, и недостающее поле уехало бы как null и заткнуло бы
 * канон на сервере (поймано смоуком: номер, приехавший EAV-пушем сида раньше
 * strict-pull'а, сносился null'ом первого же сохранения карточки).
 * Порядок слияния: EAV (подложка) < реплика (канон-в-пути) < присланные поля.
 */
export async function readEngineCardEavBase(
  db: BetterSQLite3Database,
  id: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const rows = (await db
      .select({ code: attributeDefs.code, valueJson: attributeValues.valueJson })
      .from(attributeValues)
      .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
      .innerJoin(entities, eq(entities.id, attributeValues.entityId))
      .where(
        and(
          eq(attributeValues.entityId, String(id ?? '')),
          isNull(attributeValues.deletedAt),
          isNull(attributeDefs.deletedAt),
          isNull(entities.deletedAt),
        ),
      )
      .limit(500)) as Array<{ code: string; valueJson: string | null }>;
    for (const r of rows) {
      const code = String(r.code ?? '');
      if (!isKnownEngineCardCode(code)) continue;
      out[code] = parseEavScalar(r.valueJson);
    }
  } catch {
    // нет EAV-таблиц/строк — подложка пустая, дальше решает реплика и гейты
  }
  return out;
}

function parseEavScalar(valueJson: string | null): unknown {
  if (valueJson == null) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(String(valueJson));
  } catch {
    return String(valueJson);
  }
  if (parsed === true || parsed === 1 || parsed === 'true' || parsed === '1') return true;
  if (parsed === false || parsed === 0 || parsed === 'false' || parsed === '0') return false;
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return Math.trunc(parsed);
  if (typeof parsed === 'string') return parsed;
  return null;
}

function normValue(col: keyof CardRow, value: unknown): unknown {
  // Флаги — только boolean (зеркало читает отсутствие как false, в таблице NOT NULL):
  // null/undefined здесь означают «не прислано», а не «снять», и маппятся в false.
  if (FLAG_COLS.has(col as string)) return value === true || value === 1;
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return String(value);
}

/**
 * Локальная запись полей карточки (pending). Пишется ПОЛНАЯ строка: подложка —
 * EAV-база, поверх неё текущая реплика, поверх — присланные поля. Возвращает
 * changed=false, если реплика уже несёт те же значения (повторный сейв без
 * правок не дёргает очередь).
 */
export async function saveEngineCardStrict(
  db: BetterSQLite3Database,
  id: string,
  fields: Record<string, unknown>,
  nowMs: number,
): Promise<{ changed: boolean }> {
  const engineId = String(id ?? '').trim();
  if (!engineId) throw new Error('пустой id двигателя');
  const now = Number(nowMs) > 0 ? Math.trunc(Number(nowMs)) : Date.now();
  const known = Object.entries(fields).filter(([code, v]) => isKnownEngineCardCode(code) && v !== undefined);
  if (known.length === 0) return { changed: false };
  const cur = await readEngineCardStrict(db, engineId);
  const eavBase = cur ? null : await readEngineCardEavBase(db, engineId);
  const fieldMap = new Map(known);
  const want: Partial<CardRow> = {};
  for (const code of Object.keys(CODE_TO_COL)) {
    const col = CODE_TO_COL[code] as keyof CardRow;
    const v = fieldMap.has(code)
      ? fieldMap.get(code)
      : cur
        ? (cur as Record<string, unknown>)[col]
        : (eavBase?.[code] ?? null);
    (want as Record<string, unknown>)[col] = normValue(col, v);
  }
  if (!cur) {
    await db.insert(erpEngineCards).values({
      ...(want as Record<string, unknown>),
      id: engineId,
      createdAt: now,
      updatedAt: now,
      lastServerSeq: null,
      deletedAt: null,
      syncStatus: 'pending',
    } as typeof erpEngineCards.$inferInsert);
    return { changed: true };
  }
  const curRec = cur as Record<string, unknown>;
  const wantRec = want as Record<string, unknown>;
  const dirty = Object.keys(CODE_TO_COL).some((code) => {
    const col = CODE_TO_COL[code] as string;
    return !sameValue(curRec[col], wantRec[col]);
  });
  if (!dirty) return { changed: false };
  await db
    .update(erpEngineCards)
    .set({ ...wantRec, updatedAt: now, lastServerSeq: null, syncStatus: 'pending' } as Partial<CardRow>)
    .where(eq(erpEngineCards.id, engineId));
  return { changed: true };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a == null || a === '') && (b == null || b === '')) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return Number(a) === Number(b) && a !== '' && b !== '';
}
