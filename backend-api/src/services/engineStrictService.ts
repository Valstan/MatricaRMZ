import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import {
  engineInternalNumberDuplicateMessage,
  engineInternalNumberKey,
  normalizeLookupCompact,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { entities, erpEngineCards } from '../database/schema.js';
import { setEntityAttribute } from './adminMasterdataService.js';
import {
  engineHasDuplicateBypassFlag,
  findEngineDuplicateByNumber,
  findEngineInternalNumberDuplicate,
} from './engineNumberGuard.js';
import { logWarn } from '../utils/logger.js';

/**
 * Серверные двери записи карточки двигателя в строгую таблицу (план
 * engine-cards-strict-2026-10, шаг E2). Образец — C1 (`contractStrictService`):
 * полевой патч + get, whitelist, dual-write EAV-следом, гейты дублей.
 *
 * Нормализация — зеркально-совместимая (иначе триггер `rebuild_erp_engine_card`
 * увидит «изменение» и parity покраснеет): пустая строка текста хранится NULL
 * (`eav_attr_text` делает `nullif(v,'')`), флаги — только boolean (снятие
 * атрибута зеркало читает как false, NULL-состояния у флагов нет), даты — ms,
 * ссылки — валидный uuid. Дверь пишет strict и след одними значениями.
 *
 * Вне скоупа E2 (как в E1): создание двигателей (сущности материализуются
 * существующими потоками, copyToNew — E4), вход `erp_engine_cards` в
 * sync-контракт (waiver живёт до E3, когда решится push-vs-REST), клиент (E3).
 */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type DoorActor = { id: string; username: string };

const uuid = z.string().uuid();
const msOrNull = z.number().int().nonnegative().nullable().optional();
const textOrNull = z.string().nullable().optional();
const flag = z.boolean().optional();
const uuidOrNull = z.string().uuid().nullable().optional();

const engineCardPatchSchema = z.object({
  engine_number: textOrNull,
  engine_internal_number: textOrNull,
  engine_internal_number_year: msOrNull,
  engine_brand_id: uuidOrNull,
  engine_brand: textOrNull,
  arrival_date: msOrNull,
  customer_id: uuidOrNull,
  contract_id: uuidOrNull,
  contract_section_number: textOrNull,
  workshop_id: uuidOrNull,
  status_rework_sent: flag,
  status_rework_sent_date: msOrNull,
  status_scrap_confirmed: flag,
  status_scrap_confirmed_date: msOrNull,
  status_repair_started: flag,
  status_repair_started_date: msOrNull,
  status_repaired: flag,
  status_repaired_date: msOrNull,
  status_customer_sent: flag,
  status_customer_sent_date: msOrNull,
  status_customer_accepted: flag,
  status_customer_accepted_date: msOrNull,
  status_storage_received: flag,
  status_storage_received_date: msOrNull,
  status_rejected: flag,
  status_rejected_date: msOrNull,
  scrap_reason: textOrNull,
  reclamation_flag: flag,
  reclamation_accepted_date: msOrNull,
  reclamation_customer_reason: textOrNull,
  reclamation_actual_defect: textOrNull,
  reclamation_defect_nature: textOrNull,
  reclamation_act_number: textOrNull,
  reclamation_verdict_date: msOrNull,
  reclamation_shipped_date: msOrNull,
  reclamation_comment: textOrNull,
  reclamation_verdict: textOrNull,
  reclamation_repair_status: textOrNull,
  repeat_arrival_flag: flag,
  number_collision_flag: flag,
  previous_arrival_id: uuidOrNull,
  merged_into: uuidOrNull,
  arrival_invoice: textOrNull,
  shipment_invoice: textOrNull,
  engine_note: textOrNull,
  docs_state: textOrNull,
  docs_aspvr_contractor_date: msOrNull,
  docs_vp_sent_date: msOrNull,
  docs_vp_returned_date: msOrNull,
  docs_aspvr_customer_scan_date: msOrNull,
  docs_aspvr_customer_original_date: msOrNull,
  docs_track_or_act: textOrNull,
  docs_aspvr_signed_customer_date: msOrNull,
  docs_aspvr_customer_received: flag,
  docs_return_scan_date: msOrNull,
  docs_return_original_date: msOrNull,
  docs_note: textOrNull,
});

type EngineCardPatch = z.infer<typeof engineCardPatchSchema>;

const ENGINE_CARD_PATCH_KEYS = new Set(Object.keys(engineCardPatchSchema.shape));

const UUID_REF_CODES = [
  'engine_brand_id',
  'customer_id',
  'contract_id',
  'workshop_id',
  'previous_arrival_id',
  'merged_into',
] as const;

function rejectUnknown(input: Record<string, unknown>): string | null {
  const bad = Object.keys(input).filter((k) => !ENGINE_CARD_PATCH_KEYS.has(k));
  return bad.length > 0 ? `неизвестные поля карточки двигателя: ${bad.join(', ')}` : null;
}

function nowMs(): number {
  return Date.now();
}

/** Пустая строка — NULL, как `eav_attr_text` (`nullif(v,'')`). Трима нет — зеркало не тримит. */
function textOrNullDb(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return v;
}

function toEngineCardRow(r: typeof erpEngineCards.$inferSelect): Record<string, unknown> {
  return {
    id: String(r.id),
    engine_number: r.engineNumber ?? null,
    engine_internal_number: r.engineInternalNumber ?? null,
    engine_internal_number_year: r.engineInternalNumberYear ?? null,
    engine_brand_id: r.engineBrandId ? String(r.engineBrandId) : null,
    engine_brand: r.engineBrand ?? null,
    arrival_date: r.arrivalDate ?? null,
    customer_id: r.customerId ? String(r.customerId) : null,
    contract_id: r.contractId ? String(r.contractId) : null,
    contract_section_number: r.contractSectionNumber ?? null,
    workshop_id: r.workshopId ? String(r.workshopId) : null,
    status_rework_sent: r.statusReworkSent ?? false,
    status_rework_sent_date: r.statusReworkSentDate ?? null,
    status_scrap_confirmed: r.statusScrapConfirmed ?? false,
    status_scrap_confirmed_date: r.statusScrapConfirmedDate ?? null,
    status_repair_started: r.statusRepairStarted ?? false,
    status_repair_started_date: r.statusRepairStartedDate ?? null,
    status_repaired: r.statusRepaired ?? false,
    status_repaired_date: r.statusRepairedDate ?? null,
    status_customer_sent: r.statusCustomerSent ?? false,
    status_customer_sent_date: r.statusCustomerSentDate ?? null,
    status_customer_accepted: r.statusCustomerAccepted ?? false,
    status_customer_accepted_date: r.statusCustomerAcceptedDate ?? null,
    status_storage_received: r.statusStorageReceived ?? false,
    status_storage_received_date: r.statusStorageReceivedDate ?? null,
    status_rejected: r.statusRejected ?? false,
    status_rejected_date: r.statusRejectedDate ?? null,
    scrap_reason: r.scrapReason ?? null,
    reclamation_flag: r.reclamationFlag ?? false,
    reclamation_accepted_date: r.reclamationAcceptedDate ?? null,
    reclamation_customer_reason: r.reclamationCustomerReason ?? null,
    reclamation_actual_defect: r.reclamationActualDefect ?? null,
    reclamation_defect_nature: r.reclamationDefectNature ?? null,
    reclamation_act_number: r.reclamationActNumber ?? null,
    reclamation_verdict_date: r.reclamationVerdictDate ?? null,
    reclamation_shipped_date: r.reclamationShippedDate ?? null,
    reclamation_comment: r.reclamationComment ?? null,
    reclamation_verdict: r.reclamationVerdict ?? null,
    reclamation_repair_status: r.reclamationRepairStatus ?? null,
    repeat_arrival_flag: r.repeatArrivalFlag ?? false,
    number_collision_flag: r.numberCollisionFlag ?? false,
    previous_arrival_id: r.previousArrivalId ? String(r.previousArrivalId) : null,
    merged_into: r.mergedInto ? String(r.mergedInto) : null,
    arrival_invoice: r.arrivalInvoice ?? null,
    shipment_invoice: r.shipmentInvoice ?? null,
    engine_note: r.engineNote ?? null,
    docs_state: r.docsState ?? null,
    docs_aspvr_contractor_date: r.docsAspvrContractorDate ?? null,
    docs_vp_sent_date: r.docsVpSentDate ?? null,
    docs_vp_returned_date: r.docsVpReturnedDate ?? null,
    docs_aspvr_customer_scan_date: r.docsAspvrCustomerScanDate ?? null,
    docs_aspvr_customer_original_date: r.docsAspvrCustomerOriginalDate ?? null,
    docs_track_or_act: r.docsTrackOrAct ?? null,
    docs_aspvr_signed_customer_date: r.docsAspvrSignedCustomerDate ?? null,
    docs_aspvr_customer_received: r.docsAspvrCustomerReceived ?? false,
    docs_return_scan_date: r.docsReturnScanDate ?? null,
    docs_return_original_date: r.docsReturnOriginalDate ?? null,
    docs_note: r.docsNote ?? null,
    created_at: Number(r.createdAt),
    updated_at: Number(r.updatedAt),
    deleted_at: r.deletedAt ?? null,
  };
}

/**
 * EAV-след двери (переходный период): старые клиенты и отчёты читают EAV.
 * Только присланные поля, те же коды и те же значения, что strict. Отказ
 * следа — только warn: канон уже записан, EAV догонит. Аудит статусов
 * срабатывает внутри setEntityAttribute сам.
 */
async function writeEavTrail(
  actor: DoorActor,
  entityId: string,
  entries: Array<[code: string, value: unknown]>,
): Promise<void> {
  for (const [code, value] of entries) {
    try {
      const r = await setEntityAttribute(
        { id: actor.id, username: actor.username },
        entityId,
        code,
        value,
        { allowSyncConflicts: true },
      );
      if (!r.ok) logWarn('engine door EAV trail rejected', { entityId, code, error: r.error });
    } catch (e) {
      logWarn('engine door EAV trail failed', { entityId, code, error: String(e) });
    }
  }
}

/** След полевого патча: те же коды, что карточка писала всегда. Флаги осознанного
 * дубля — первыми: гейт номера в следе читает их из EAV, и флаг обязан лечь
 * раньше номера (та же дисциплина «флаги первыми», что у карточки). */
function trailOf(patch: EngineCardPatch): Array<[string, unknown]> {
  const trail: Array<[string, unknown]> = [];
  const text = (code: keyof EngineCardPatch & string) => {
    const v = patch[code];
    if (v !== undefined) trail.push([code, textOrNullDb(v as string | null) ?? null]);
  };
  const ms = (code: keyof EngineCardPatch & string) => {
    const v = patch[code];
    if (v !== undefined) trail.push([code, (v as number | null) ?? null]);
  };
  const fl = (code: keyof EngineCardPatch & string) => {
    const v = patch[code];
    if (v !== undefined) trail.push([code, v as boolean]);
  };
  const ref = (code: keyof EngineCardPatch & string) => {
    const v = patch[code];
    if (v !== undefined) trail.push([code, (v as string | null) ?? null]);
  };
  fl('repeat_arrival_flag');
  fl('number_collision_flag');
  text('engine_number');
  text('engine_internal_number');
  ms('engine_internal_number_year');
  ref('engine_brand_id');
  text('engine_brand');
  ms('arrival_date');
  ref('customer_id');
  ref('contract_id');
  text('contract_section_number');
  ref('workshop_id');
  fl('status_rework_sent');
  ms('status_rework_sent_date');
  fl('status_scrap_confirmed');
  ms('status_scrap_confirmed_date');
  fl('status_repair_started');
  ms('status_repair_started_date');
  fl('status_repaired');
  ms('status_repaired_date');
  fl('status_customer_sent');
  ms('status_customer_sent_date');
  fl('status_customer_accepted');
  ms('status_customer_accepted_date');
  fl('status_storage_received');
  ms('status_storage_received_date');
  fl('status_rejected');
  ms('status_rejected_date');
  text('scrap_reason');
  ms('reclamation_accepted_date');
  text('reclamation_customer_reason');
  text('reclamation_actual_defect');
  text('reclamation_defect_nature');
  text('reclamation_act_number');
  ms('reclamation_verdict_date');
  ms('reclamation_shipped_date');
  text('reclamation_comment');
  text('reclamation_verdict');
  text('reclamation_repair_status');
  fl('reclamation_flag');
  ref('previous_arrival_id');
  ref('merged_into');
  text('arrival_invoice');
  text('shipment_invoice');
  text('engine_note');
  text('docs_state');
  ms('docs_aspvr_contractor_date');
  ms('docs_vp_sent_date');
  ms('docs_vp_returned_date');
  ms('docs_aspvr_customer_scan_date');
  ms('docs_aspvr_customer_original_date');
  text('docs_track_or_act');
  ms('docs_aspvr_signed_customer_date');
  fl('docs_aspvr_customer_received');
  ms('docs_return_scan_date');
  ms('docs_return_original_date');
  text('docs_note');
  return trail;
}

/** Полевой патч карточки двигателя: меняются только присланные поля, холостая запись не бампит. */
export async function patchEngineCardStrict(
  id: string,
  raw: unknown,
  actor: DoorActor,
): Promise<Result<{ row: Record<string, unknown>; changed: boolean }>> {
  const engineId = String(id ?? '').trim();
  if (!uuid.safeParse(engineId).success) return { ok: false, error: 'неверный id двигателя' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'ожидался объект полей карточки' };
  const input = raw as Record<string, unknown>;
  const rejected = rejectUnknown(input);
  if (rejected) return { ok: false, error: rejected };
  const parsed = engineCardPatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `неверные поля карточки: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  }
  const patch = parsed.data;
  const existing = await db.select().from(erpEngineCards).where(eq(erpEngineCards.id, engineId as any)).limit(1);
  const cur = existing[0];
  if (!cur || cur.deletedAt != null) return { ok: false, error: 'двигатель не найден' };

  if (patch.engine_number !== undefined) {
    // Пересохранение того же номера разрешено (смена регистра/пробелов),
    // новый дубль блокируется. Флаг осознанного дубля берётся из merged-
    // состояния (патч поверх БД): карточка пишет флаги первыми, и флаг из
    // того же патча тоже считается; явное снятие флага в том же патче запрет
    // возвращает. Тот же merged-взгляд обязан быть и у EAV-следа (он идёт
    // через те же гейты): поэтому след пишет флаги раньше номера.
    const prevKey = normalizeLookupCompact(cur.engineNumber ?? '');
    const nextKey = normalizeLookupCompact(patch.engine_number ?? '');
    if (nextKey && nextKey !== prevKey) {
      const dup = await findEngineDuplicateByNumber(patch.engine_number ?? '', engineId);
      if (dup) {
        const patchCarriesFlags =
          patch.repeat_arrival_flag !== undefined || patch.number_collision_flag !== undefined;
        const bypass = patchCarriesFlags
          ? patch.repeat_arrival_flag === true || patch.number_collision_flag === true
          : await engineHasDuplicateBypassFlag(engineId);
        if (!bypass) {
          return {
            ok: false,
            error: `Двигатель с номером «${dup.engineNumber}» уже существует. Откройте его карточку вместо создания дубля.`,
          };
        }
      }
    }
  }
  if (patch.engine_internal_number !== undefined || patch.engine_internal_number_year !== undefined) {
    // Пара (номер, год); второй элемент — из strict-строки, если не прислан.
    // Флаги осознанного дубля сюда не распространяются: клеймо выдаёт завод.
    const nextNumber = patch.engine_internal_number ?? cur.engineInternalNumber ?? '';
    const nextYear = patch.engine_internal_number_year ?? cur.engineInternalNumberYear ?? null;
    const nextKey = engineInternalNumberKey(nextNumber, nextYear);
    const curKey = engineInternalNumberKey(cur.engineInternalNumber ?? '', cur.engineInternalNumberYear ?? null);
    if (nextKey && nextKey !== curKey) {
      const dup = await findEngineInternalNumberDuplicate(nextNumber, nextYear, engineId);
      if (dup) return { ok: false, error: engineInternalNumberDuplicateMessage(dup) };
    }
  }
  const refs = UUID_REF_CODES.filter((c) => patch[c] !== undefined && patch[c] !== null) as string[];
  if (refs.length > 0) {
    const ids = refs.map((c) => String(patch[c as keyof EngineCardPatch]));
    const found = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(inArray(entities.id, ids as any), isNull(entities.deletedAt)))
      .limit(ids.length);
    const foundIds = new Set(found.map((r) => String(r.id)));
    const missing = refs.filter((c) => !foundIds.has(String(patch[c as keyof EngineCardPatch])));
    if (missing.length > 0) return { ok: false, error: `ссылки на несуществующие объекты: ${missing.join(', ')}` };
  }

  const ts = nowMs();
  const set = {
    ...(patch.engine_number !== undefined ? { engineNumber: textOrNullDb(patch.engine_number) ?? null } : {}),
    ...(patch.engine_internal_number !== undefined ? { engineInternalNumber: textOrNullDb(patch.engine_internal_number) ?? null } : {}),
    ...(patch.engine_internal_number_year !== undefined ? { engineInternalNumberYear: patch.engine_internal_number_year ?? null } : {}),
    ...(patch.engine_brand_id !== undefined ? { engineBrandId: (patch.engine_brand_id ?? null) as any } : {}),
    ...(patch.engine_brand !== undefined ? { engineBrand: textOrNullDb(patch.engine_brand) ?? null } : {}),
    ...(patch.arrival_date !== undefined ? { arrivalDate: patch.arrival_date ?? null } : {}),
    ...(patch.customer_id !== undefined ? { customerId: (patch.customer_id ?? null) as any } : {}),
    ...(patch.contract_id !== undefined ? { contractId: (patch.contract_id ?? null) as any } : {}),
    ...(patch.contract_section_number !== undefined ? { contractSectionNumber: textOrNullDb(patch.contract_section_number) ?? null } : {}),
    ...(patch.workshop_id !== undefined ? { workshopId: (patch.workshop_id ?? null) as any } : {}),
    ...(patch.status_rework_sent !== undefined ? { statusReworkSent: patch.status_rework_sent } : {}),
    ...(patch.status_rework_sent_date !== undefined ? { statusReworkSentDate: patch.status_rework_sent_date ?? null } : {}),
    ...(patch.status_scrap_confirmed !== undefined ? { statusScrapConfirmed: patch.status_scrap_confirmed } : {}),
    ...(patch.status_scrap_confirmed_date !== undefined ? { statusScrapConfirmedDate: patch.status_scrap_confirmed_date ?? null } : {}),
    ...(patch.status_repair_started !== undefined ? { statusRepairStarted: patch.status_repair_started } : {}),
    ...(patch.status_repair_started_date !== undefined ? { statusRepairStartedDate: patch.status_repair_started_date ?? null } : {}),
    ...(patch.status_repaired !== undefined ? { statusRepaired: patch.status_repaired } : {}),
    ...(patch.status_repaired_date !== undefined ? { statusRepairedDate: patch.status_repaired_date ?? null } : {}),
    ...(patch.status_customer_sent !== undefined ? { statusCustomerSent: patch.status_customer_sent } : {}),
    ...(patch.status_customer_sent_date !== undefined ? { statusCustomerSentDate: patch.status_customer_sent_date ?? null } : {}),
    ...(patch.status_customer_accepted !== undefined ? { statusCustomerAccepted: patch.status_customer_accepted } : {}),
    ...(patch.status_customer_accepted_date !== undefined ? { statusCustomerAcceptedDate: patch.status_customer_accepted_date ?? null } : {}),
    ...(patch.status_storage_received !== undefined ? { statusStorageReceived: patch.status_storage_received } : {}),
    ...(patch.status_storage_received_date !== undefined ? { statusStorageReceivedDate: patch.status_storage_received_date ?? null } : {}),
    ...(patch.status_rejected !== undefined ? { statusRejected: patch.status_rejected } : {}),
    ...(patch.status_rejected_date !== undefined ? { statusRejectedDate: patch.status_rejected_date ?? null } : {}),
    ...(patch.scrap_reason !== undefined ? { scrapReason: textOrNullDb(patch.scrap_reason) ?? null } : {}),
    ...(patch.reclamation_flag !== undefined ? { reclamationFlag: patch.reclamation_flag } : {}),
    ...(patch.reclamation_accepted_date !== undefined ? { reclamationAcceptedDate: patch.reclamation_accepted_date ?? null } : {}),
    ...(patch.reclamation_customer_reason !== undefined ? { reclamationCustomerReason: textOrNullDb(patch.reclamation_customer_reason) ?? null } : {}),
    ...(patch.reclamation_actual_defect !== undefined ? { reclamationActualDefect: textOrNullDb(patch.reclamation_actual_defect) ?? null } : {}),
    ...(patch.reclamation_defect_nature !== undefined ? { reclamationDefectNature: textOrNullDb(patch.reclamation_defect_nature) ?? null } : {}),
    ...(patch.reclamation_act_number !== undefined ? { reclamationActNumber: textOrNullDb(patch.reclamation_act_number) ?? null } : {}),
    ...(patch.reclamation_verdict_date !== undefined ? { reclamationVerdictDate: patch.reclamation_verdict_date ?? null } : {}),
    ...(patch.reclamation_shipped_date !== undefined ? { reclamationShippedDate: patch.reclamation_shipped_date ?? null } : {}),
    ...(patch.reclamation_comment !== undefined ? { reclamationComment: textOrNullDb(patch.reclamation_comment) ?? null } : {}),
    ...(patch.reclamation_verdict !== undefined ? { reclamationVerdict: textOrNullDb(patch.reclamation_verdict) ?? null } : {}),
    ...(patch.reclamation_repair_status !== undefined ? { reclamationRepairStatus: textOrNullDb(patch.reclamation_repair_status) ?? null } : {}),
    ...(patch.repeat_arrival_flag !== undefined ? { repeatArrivalFlag: patch.repeat_arrival_flag } : {}),
    ...(patch.number_collision_flag !== undefined ? { numberCollisionFlag: patch.number_collision_flag } : {}),
    ...(patch.previous_arrival_id !== undefined ? { previousArrivalId: (patch.previous_arrival_id ?? null) as any } : {}),
    ...(patch.merged_into !== undefined ? { mergedInto: (patch.merged_into ?? null) as any } : {}),
    ...(patch.arrival_invoice !== undefined ? { arrivalInvoice: textOrNullDb(patch.arrival_invoice) ?? null } : {}),
    ...(patch.shipment_invoice !== undefined ? { shipmentInvoice: textOrNullDb(patch.shipment_invoice) ?? null } : {}),
    ...(patch.engine_note !== undefined ? { engineNote: textOrNullDb(patch.engine_note) ?? null } : {}),
    ...(patch.docs_state !== undefined ? { docsState: textOrNullDb(patch.docs_state) ?? null } : {}),
    ...(patch.docs_aspvr_contractor_date !== undefined ? { docsAspvrContractorDate: patch.docs_aspvr_contractor_date ?? null } : {}),
    ...(patch.docs_vp_sent_date !== undefined ? { docsVpSentDate: patch.docs_vp_sent_date ?? null } : {}),
    ...(patch.docs_vp_returned_date !== undefined ? { docsVpReturnedDate: patch.docs_vp_returned_date ?? null } : {}),
    ...(patch.docs_aspvr_customer_scan_date !== undefined ? { docsAspvrCustomerScanDate: patch.docs_aspvr_customer_scan_date ?? null } : {}),
    ...(patch.docs_aspvr_customer_original_date !== undefined ? { docsAspvrCustomerOriginalDate: patch.docs_aspvr_customer_original_date ?? null } : {}),
    ...(patch.docs_track_or_act !== undefined ? { docsTrackOrAct: textOrNullDb(patch.docs_track_or_act) ?? null } : {}),
    ...(patch.docs_aspvr_signed_customer_date !== undefined ? { docsAspvrSignedCustomerDate: patch.docs_aspvr_signed_customer_date ?? null } : {}),
    ...(patch.docs_aspvr_customer_received !== undefined ? { docsAspvrCustomerReceived: patch.docs_aspvr_customer_received } : {}),
    ...(patch.docs_return_scan_date !== undefined ? { docsReturnScanDate: patch.docs_return_scan_date ?? null } : {}),
    ...(patch.docs_return_original_date !== undefined ? { docsReturnOriginalDate: patch.docs_return_original_date ?? null } : {}),
    ...(patch.docs_note !== undefined ? { docsNote: textOrNullDb(patch.docs_note) ?? null } : {}),
  };
  if (Object.keys(set).length === 0) return { ok: true, row: toEngineCardRow(cur), changed: false };
  const updated = await db
    .update(erpEngineCards)
    .set({ ...set, updatedAt: ts, syncStatus: 'pending' })
    .where(eq(erpEngineCards.id, engineId as any))
    .returning();
  const row = updated[0];
  if (!row) return { ok: false, error: 'не удалось сохранить карточку' };
  await writeEavTrail(actor, engineId, trailOf(patch));
  // Ответ — перечитанная строка, а не returning update: след идёт через те же
  // гейты и триггер зеркала пересобирает строку из EAV следом. Если след
  // согласился не со всем (гейт EAV-пути отбил часть), зеркало уже привело
  // strict к EAV — ответ обязан показать реальность, а не намерение.
  const reread = await db.select().from(erpEngineCards).where(eq(erpEngineCards.id, engineId as any)).limit(1);
  return { ok: true, row: toEngineCardRow(reread[0] ?? row), changed: true };
}

export async function getEngineCardStrict(id: string): Promise<Result<{ row: Record<string, unknown> }>> {
  const engineId = String(id ?? '').trim();
  if (!uuid.safeParse(engineId).success) return { ok: false, error: 'неверный id двигателя' };
  const rows = await db.select().from(erpEngineCards).where(eq(erpEngineCards.id, engineId as any)).limit(1);
  const row = rows[0];
  if (!row || row.deletedAt != null) return { ok: false, error: 'двигатель не найден' };
  return { ok: true, row: toEngineCardRow(row) };
}
