import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_BULK_INTAKE_MAX,
  engineBulkIntakeKey,
  engineBulkIntakeMissingFields,
  parseEngineBulkIntake,
  parseRepairHistoryMeta,
  readBulkIntakeInternalNumber,
  repairHistoryEntryType,
  REPAIR_HISTORY_OPERATION_TYPE,
  type EngineBulkIntakeApplyInput,
  type EngineBulkIntakeApplyResult,
  type EngineBulkIntakeExisting,
  type EngineBulkIntakeOffer,
  type EngineBulkIntakePreview,
  type EngineBulkIntakeRowInput,
} from '@matricarmz/shared';

import { attributeValues, entities, entityTypes, erpEngineCards, operations } from '../database/schema.js';
import { getContractCustomerMap, getDisplayNameMap, getEngineAttrDefs } from './engineService.js';
import { saveEngineCardGated, type EngineCardWriteDeps } from './engineCardWrite.js';
import { ensureRepairStageRow } from './repairStageService.js';

/**
 * Пакетный приём двигателей списком: оператор вставляет номера из накладной и
 * заполняет столько общих полей, сколько знает (с 20.10.2026 все необязательны) —
 * программа заводит карточку на каждый номер. Тот же список можно принести второй
 * раз уже с внутренними номерами и договором: тогда карточки НЕ пропускаются, а
 * дополняются недостающим.
 *
 * Почему в main, а не в рендерере: гейты дублей и запись карточки живут здесь
 * (`saveEngineCardGated`), права тоже проверяются на этой стороне. Рендерер
 * только показывает превью и собирает решение оператора по дублям.
 */

type Detail = Omit<EngineBulkIntakeExisting, 'id' | 'engineNumber' | 'hasDefectStage'>;

/** Этап «Разборка/Дефектовка» — единственный дом даты дефектовки с 01.10.2026. */
const DEFECT_STAGE_CODE = 'disassembly_defect';

const CARD_DETAIL_CODES = [
  'arrival_date',
  'engine_brand',
  'engine_brand_id',
  'customer_id',
  'contract_id',
  'engine_internal_number',
  'engine_internal_number_year',
] as const;

const EMPTY_DETAIL: Detail = {
  arrivalDate: null,
  engineBrandId: null,
  engineBrand: null,
  customerId: null,
  contractId: null,
  internalNumber: null,
  internalNumberYear: null,
};

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function text(value: unknown): string | null {
  const parsed = parseJson(value);
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null;
}

function ms(value: unknown): number | null {
  const parsed = parseJson(value);
  const num = typeof parsed === 'number' ? parsed : Number(parsed);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : null;
}

function int(value: unknown): number | null {
  const parsed = parseJson(value);
  const num = typeof parsed === 'number' ? parsed : Number(parsed);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

/**
 * Подробности EAV-карточек, которых нет в строгой реплике (легаси-двигатели до
 * pull'а strict-таблицы). Запрашиваются только по совпавшим номерам — весь EAV
 * ради превью не читаем.
 */
async function readEavDetails(
  db: BetterSQLite3Database,
  defs: Record<string, string>,
  engineIds: readonly string[],
): Promise<Map<string, Detail>> {
  const out = new Map<string, Detail>();
  if (engineIds.length === 0) return out;
  const defIds = CARD_DETAIL_CODES.map((code) => defs[code]).filter((id): id is string => Boolean(id));
  if (defIds.length === 0) return out;
  const codeByDef = new Map<string, string>();
  for (const code of CARD_DETAIL_CODES) {
    const id = defs[code];
    if (id) codeByDef.set(id, code);
  }
  const rows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, [...engineIds]),
        inArray(attributeValues.attributeDefId, defIds),
        isNull(attributeValues.deletedAt),
      ),
    );
  for (const row of rows) {
    const code = codeByDef.get(String(row.attributeDefId));
    if (!code) continue;
    const engineId = String(row.entityId);
    const cur = out.get(engineId) ?? { ...EMPTY_DETAIL };
    if (code === 'arrival_date') cur.arrivalDate = ms(row.valueJson);
    else if (code === 'engine_brand') cur.engineBrand = text(row.valueJson);
    else if (code === 'engine_brand_id') cur.engineBrandId = text(row.valueJson);
    else if (code === 'customer_id') cur.customerId = text(row.valueJson);
    else if (code === 'contract_id') cur.contractId = text(row.valueJson);
    else if (code === 'engine_internal_number') cur.internalNumber = text(row.valueJson);
    else if (code === 'engine_internal_number_year') cur.internalNumberYear = int(row.valueJson);
    out.set(engineId, cur);
  }
  return out;
}

/**
 * Двигатели, у которых уже стоит строка этапа «Разборка/Дефектовка»: туда дату
 * дефектовки не дописываем (этап идемпотентен, но оператору надо видеть, что
 * дополнять нечего).
 */
async function loadDefectStageEngineIds(
  db: BetterSQLite3Database,
  engineIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (engineIds.length === 0) return out;
  const rows = await db
    .select({ engineId: operations.engineEntityId, metaJson: operations.metaJson })
    .from(operations)
    .where(
      and(
        inArray(operations.engineEntityId, [...engineIds]),
        eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE),
        isNull(operations.deletedAt),
      ),
    );
  for (const row of rows) {
    const meta = parseRepairHistoryMeta(typeof row.metaJson === 'string' ? row.metaJson : null);
    if (!meta || repairHistoryEntryType(meta, REPAIR_HISTORY_OPERATION_TYPE) !== 'stage') continue;
    if (String(meta.stage?.code ?? '') === DEFECT_STAGE_CODE) out.add(String(row.engineId));
  }
  return out;
}

/**
 * Карта «канон-ключ номера → двигатель» на момент вызова. Реплика — канон-в-пути
 * (видит и локальные pending-карточки), EAV — подложка для тех, кто в реплику ещё
 * не приехал. Номер из реплики побеждает: EAV-след может отставать от strict-правки.
 */
async function loadEngineNumberIndex(
  db: BetterSQLite3Database,
  numbers: readonly string[],
): Promise<Map<string, EngineBulkIntakeExisting>> {
  const wanted = new Set(numbers.map((n) => engineBulkIntakeKey(n)).filter(Boolean));
  const out = new Map<string, EngineBulkIntakeExisting>();
  if (wanted.size === 0) return out;

  const replicaRows = await db
    .select({
      id: erpEngineCards.id,
      engineNumber: erpEngineCards.engineNumber,
      arrivalDate: erpEngineCards.arrivalDate,
      engineBrandId: erpEngineCards.engineBrandId,
      engineBrand: erpEngineCards.engineBrand,
      customerId: erpEngineCards.customerId,
      contractId: erpEngineCards.contractId,
      internalNumber: erpEngineCards.engineInternalNumber,
      internalNumberYear: erpEngineCards.engineInternalNumberYear,
    })
    .from(erpEngineCards)
    .where(isNull(erpEngineCards.deletedAt));
  const replicaIds = new Set<string>();
  for (const row of replicaRows) {
    replicaIds.add(String(row.id));
    const number = String(row.engineNumber ?? '').trim();
    const key = engineBulkIntakeKey(number);
    if (!key || !wanted.has(key) || out.has(key)) continue;
    out.set(key, {
      id: String(row.id),
      engineNumber: number,
      arrivalDate: row.arrivalDate == null ? null : Number(row.arrivalDate),
      engineBrandId: row.engineBrandId == null ? null : String(row.engineBrandId),
      engineBrand: row.engineBrand == null ? null : String(row.engineBrand),
      customerId: row.customerId == null ? null : String(row.customerId),
      contractId: row.contractId == null ? null : String(row.contractId),
      internalNumber: row.internalNumber == null ? null : String(row.internalNumber),
      internalNumberYear: row.internalNumberYear == null ? null : Number(row.internalNumberYear),
      hasDefectStage: false,
    });
  }

  if (out.size < wanted.size) {
    const defs = await getEngineAttrDefs(db);
    const numberDefId = defs['engine_number'];
    if (numberDefId) {
      const eavRows = await db
        .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
        .from(attributeValues)
        .innerJoin(entities, eq(entities.id, attributeValues.entityId))
        .where(
          and(
            eq(attributeValues.attributeDefId, numberDefId),
            isNull(attributeValues.deletedAt),
            isNull(entities.deletedAt),
          ),
        );

      const matchedIds: string[] = [];
      const matchedKeys = new Map<string, { id: string; engineNumber: string }>();
      for (const row of eavRows) {
        const id = String(row.entityId);
        if (replicaIds.has(id)) continue;
        const number = text(row.valueJson);
        if (!number) continue;
        const key = engineBulkIntakeKey(number);
        if (!key || !wanted.has(key) || out.has(key) || matchedKeys.has(key)) continue;
        matchedKeys.set(key, { id, engineNumber: number });
        matchedIds.push(id);
      }
      if (matchedIds.length > 0) {
        const details = await readEavDetails(db, defs, matchedIds);
        for (const [key, card] of matchedKeys) {
          out.set(key, {
            ...card,
            ...(details.get(card.id) ?? EMPTY_DETAIL),
            hasDefectStage: false,
          });
        }
      }
    }
  }

  if (out.size === 0) return out;
  const withDefectStage = await loadDefectStageEngineIds(
    db,
    [...out.values()].map((card) => card.id),
  );
  for (const card of out.values()) card.hasDefectStage = withDefectStage.has(card.id);
  return out;
}

export async function previewEngineBulkIntake(
  db: BetterSQLite3Database,
  text_: string,
): Promise<EngineBulkIntakePreview> {
  const parsed = parseEngineBulkIntake(text_);
  const repeatedKeys = new Set(parsed.repeated.map((n) => engineBulkIntakeKey(n)));
  const index = await loadEngineNumberIndex(db, parsed.numbers);
  const rows = parsed.numbers.map((number) => {
    const key = engineBulkIntakeKey(number);
    return {
      number,
      key,
      existing: index.get(key) ?? null,
      repeatedInBatch: repeatedKeys.has(key),
    };
  });
  return { rows, overflow: Math.max(0, rows.length - ENGINE_BULK_INTAKE_MAX) };
}

async function entityTypeId(db: BetterSQLite3Database, code: string): Promise<string | null> {
  const rows = await db.select({ id: entityTypes.id }).from(entityTypes).where(eq(entityTypes.code, code)).limit(1);
  return rows[0]?.id ?? null;
}

function trimOrNull(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s ? s : null;
}

function msOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * Завести карточки и дополнить существующие по решению оператора. Общие поля
 * (марка/контрагент/договор/даты) необязательны — карточка без них допустима и на
 * сервере (`erp_engine_cards`: все предметные колонки nullable).
 */
export async function applyEngineBulkIntake(
  deps: EngineCardWriteDeps,
  input: EngineBulkIntakeApplyInput,
): Promise<EngineBulkIntakeApplyResult> {
  const { db } = deps;
  const brandId = trimOrNull(input?.brandId);
  const contractId = trimOrNull(input?.contractId);
  const arrivalDate = msOrNull(input?.arrivalDate);
  const defectDate = msOrNull(input?.defectDate);
  const rows = Array.isArray(input?.rows) ? input.rows : [];

  if (rows.length === 0) return { ok: false, error: 'Список двигателей пуст.' };
  if (rows.length > ENGINE_BULK_INTAKE_MAX) {
    return {
      ok: false,
      error: `За один раз принимаем не больше ${ENGINE_BULK_INTAKE_MAX} номеров. Разделите список на части.`,
    };
  }

  // Договор называет своего контрагента: если оператор выбрал только договор,
  // контрагента берём оттуда — иначе карточка осталась бы без заказчика.
  const contractCustomers = contractId ? await getContractCustomerMap(db) : null;
  let customerId = trimOrNull(input?.customerId);
  if (!customerId && contractId) customerId = contractCustomers?.get(contractId) ?? null;

  const brandLabel = brandId ? ((await getDisplayNameMap(db, 'engine_brand')).get(brandId) ?? null) : null;
  if (brandId && !brandLabel) {
    return { ok: false, error: 'Марка двигателя не найдена в базе — обновите список и выберите заново.' };
  }
  const customerName = customerId ? ((await getDisplayNameMap(db, 'customer')).get(customerId) ?? null) : null;
  if (customerId && !customerName) {
    return { ok: false, error: 'Контрагент не найден в базе — обновите список и выберите заново.' };
  }
  const contractName = contractId ? ((await getDisplayNameMap(db, 'contract')).get(contractId) ?? null) : null;
  if (contractId && !contractName) {
    return { ok: false, error: 'Договор не найден в базе — обновите список и выберите заново.' };
  }
  const contractCustomerId = contractCustomers?.get(contractId ?? '') ?? '';
  if (contractCustomerId && customerId && contractCustomerId !== customerId) {
    return {
      ok: false,
      error: `Договор «${contractName ?? ''}» принадлежит другому контрагенту. Выберите договор этого контрагента.`,
    };
  }

  const engineTypeId = await entityTypeId(db, 'engine');
  if (!engineTypeId) return { ok: false, error: 'В базе нет типа сущности «двигатель» — обратитесь к администратору.' };

  const nowMs = Date.now();
  const numbers = rows.map((row) => String(row?.number ?? '').trim()).filter(Boolean);
  const existingByKey = await loadEngineNumberIndex(db, numbers);

  const offerForRow = (row: EngineBulkIntakeRowInput | undefined): EngineBulkIntakeOffer => {
    const internal = readBulkIntakeInternalNumber(String(row?.internalNumber ?? ''), nowMs);
    return {
      brandId,
      customerId,
      contractId,
      arrivalDate,
      internalNumber: internal.number,
      internalNumberYear: internal.year,
      defectDate,
    };
  };

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let defectStageMissed = 0;
  let defectStageError: string | null = null;
  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const contractedIds: string[] = [];
  const seen = new Set<string>();

  const markDefectStage = async (engineId: string): Promise<boolean> => {
    if (!defectDate) return false;
    if (!deps.canWriteStageRow) {
      defectStageMissed += 1;
      defectStageError ??= 'Нет права писать этапы работ — дата дефектовки не поставлена.';
      return false;
    }
    try {
      const r = await ensureRepairStageRow(db, engineId, DEFECT_STAGE_CODE, defectDate, deps.actor || 'local');
      if (r.ok) return true;
      defectStageMissed += 1;
      defectStageError ??= r.error;
      return false;
    } catch (e) {
      defectStageMissed += 1;
      defectStageError ??= String(e);
      return false;
    }
  };

  for (const row of rows) {
    const number = String(row?.number ?? '').trim();
    if (!number) continue;
    const key = engineBulkIntakeKey(number);
    if (!key || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const action =
      row?.action === 'repeat_arrival'
        ? 'repeat_arrival'
        : row?.action === 'skip'
          ? 'skip'
          : row?.action === 'update'
            ? 'update'
            : 'create';
    const existing = existingByKey.get(key) ?? null;
    if (action === 'skip') {
      skipped += 1;
      continue;
    }
    const offer = offerForRow(row);

    if (action === 'update') {
      // Двигателя нет в базе — дополнять нечего (превью устарело или он удалён).
      if (!existing) {
        skipped += 1;
        continue;
      }
      const missing = engineBulkIntakeMissingFields(existing, offer);
      const fields: Record<string, unknown> = {};
      if (missing.includes('engineBrand') && brandId && brandLabel) {
        fields.engine_brand_id = brandId;
        fields.engine_brand = brandLabel;
      }
      if (missing.includes('customer') && customerId) fields.customer_id = customerId;
      if (missing.includes('contract') && contractId) fields.contract_id = contractId;
      if (missing.includes('arrivalDate') && arrivalDate) fields.arrival_date = arrivalDate;
      if (missing.includes('internalNumber') && offer.internalNumber) {
        // Год — ПЕРЕД номером: гейт пары дочитывает второй элемент из реплики.
        fields.engine_internal_number_year = offer.internalNumberYear;
        fields.engine_internal_number = offer.internalNumber;
      }
      let changed = false;
      if (Object.keys(fields).length > 0) {
        const saved = await saveEngineCardGated(deps, existing.id, fields);
        if (!saved.ok) {
          return {
            ok: false,
            error: `Заведено ${created}, дополнено ${updated} из ${rows.length} — дальше отказ: «${number}» — ${saved.error}`,
            created,
            updated,
            createdIds,
            updatedIds,
            contractedIds,
            defectStageMissed,
            defectStageError,
          };
        }
        changed = true;
        if (fields.contract_id) contractedIds.push(existing.id);
      }
      if (missing.includes('defectDate') && (await markDefectStage(existing.id))) changed = true;
      if (!changed) {
        skipped += 1;
        continue;
      }
      updated += 1;
      updatedIds.push(existing.id);
      continue;
    }

    if (action === 'create' && existing) {
      // Превью устарело (двигатель завели, пока оператор выбирал) — дубль не создаём.
      skipped += 1;
      continue;
    }
    const repeat = action === 'repeat_arrival';
    const previousEngineId = repeat ? String(row?.previousEngineId ?? '').trim() || existing?.id || '' : '';
    const engineId = randomUUID();
    const fields: Record<string, unknown> = { engine_number: number };
    if (brandId && brandLabel) {
      fields.engine_brand_id = brandId;
      fields.engine_brand = brandLabel;
    }
    if (customerId) fields.customer_id = customerId;
    if (contractId) fields.contract_id = contractId;
    if (arrivalDate) fields.arrival_date = arrivalDate;
    if (offer.internalNumber) {
      fields.engine_internal_number_year = offer.internalNumberYear;
      fields.engine_internal_number = offer.internalNumber;
    }
    if (repeat) {
      fields.repeat_arrival_flag = true;
      fields.previous_arrival_id = previousEngineId || null;
    }
    const saved = await saveEngineCardGated(deps, engineId, fields);
    if (!saved.ok) {
      return {
        ok: false,
        error:
          created > 0 || updated > 0
            ? `Заведено ${created}, дополнено ${updated} из ${rows.length} карточек, дальше отказ: «${number}» — ${saved.error}`
            : `«${number}»: ${saved.error}`,
        created,
        updated,
        createdIds,
        updatedIds,
        contractedIds,
        defectStageMissed,
        defectStageError,
      };
    }
    created += 1;
    createdIds.push(engineId);
    await markDefectStage(engineId);
  }
  return {
    ok: true,
    created,
    updated,
    skipped,
    createdIds,
    updatedIds,
    contractedIds,
    defectStageMissed,
    defectStageError,
  };
}
