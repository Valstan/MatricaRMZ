import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_BULK_INTAKE_MAX,
  engineBulkIntakeKey,
  parseEngineBulkIntake,
  type EngineBulkIntakeApplyInput,
  type EngineBulkIntakeApplyResult,
  type EngineBulkIntakeExisting,
  type EngineBulkIntakePreview,
} from '@matricarmz/shared';

import { attributeValues, entities, entityTypes, erpEngineCards } from '../database/schema.js';
import { getContractCustomerMap, getDisplayNameMap, getEngineAttrDefs } from './engineService.js';
import { saveEngineCardGated, type EngineCardWriteDeps } from './engineCardWrite.js';

/**
 * Пакетный приём двигателей списком: оператор вставляет номера из накладной,
 * один раз выбирает марку, контрагента, договор и дату прихода — программа
 * заводит карточку на каждый номер.
 *
 * Почему в main, а не в рендерере: гейты дублей и запись карточки живут здесь
 * (`saveEngineCardGated`), права тоже проверяются на этой стороне. Рендерер
 * только показывает превью и собирает решение оператора по дублям.
 */

type Detail = Omit<EngineBulkIntakeExisting, 'id' | 'engineNumber'>;

const CARD_DETAIL_CODES = ['arrival_date', 'engine_brand', 'customer_id', 'contract_id'] as const;

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
    const cur = out.get(engineId) ?? {
      arrivalDate: null,
      engineBrand: null,
      customerId: null,
      contractId: null,
    };
    if (code === 'arrival_date') cur.arrivalDate = ms(row.valueJson);
    else if (code === 'engine_brand') cur.engineBrand = text(row.valueJson);
    else if (code === 'customer_id') cur.customerId = text(row.valueJson);
    else if (code === 'contract_id') cur.contractId = text(row.valueJson);
    out.set(engineId, cur);
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
      engineBrand: erpEngineCards.engineBrand,
      customerId: erpEngineCards.customerId,
      contractId: erpEngineCards.contractId,
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
      engineBrand: row.engineBrand == null ? null : String(row.engineBrand),
      customerId: row.customerId == null ? null : String(row.customerId),
      contractId: row.contractId == null ? null : String(row.contractId),
    });
  }
  if (out.size === wanted.size) return out;

  const defs = await getEngineAttrDefs(db);
  const numberDefId = defs['engine_number'];
  if (!numberDefId) return out;
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
  if (matchedIds.length === 0) return out;
  const details = await readEavDetails(db, defs, matchedIds);
  for (const [key, card] of matchedKeys) {
    const detail = details.get(card.id) ?? {
      arrivalDate: null,
      engineBrand: null,
      customerId: null,
      contractId: null,
    };
    out.set(key, { ...card, ...detail });
  }
  return out;
}

export async function previewEngineBulkIntake(
  db: BetterSQLite3Database,
  text: string,
): Promise<EngineBulkIntakePreview> {
  const parsed = parseEngineBulkIntake(text);
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

/**
 * Завести карточки по решению оператора. Проверки «куда добавлять» (марка,
 * контрагент, договор, дата) — здесь, а не только в форме: превью могло
 * устареть, пока оператор выбирал действия по дублям.
 */
export async function applyEngineBulkIntake(
  deps: EngineCardWriteDeps,
  input: EngineBulkIntakeApplyInput,
): Promise<EngineBulkIntakeApplyResult> {
  const { db } = deps;
  const brandId = String(input?.brandId ?? '').trim();
  const customerId = String(input?.customerId ?? '').trim();
  const contractId = String(input?.contractId ?? '').trim();
  const arrivalDate = Number(input?.arrivalDate);
  const rows = Array.isArray(input?.rows) ? input.rows : [];

  if (!brandId) return { ok: false, error: 'Не выбрана марка двигателя — приём отменён.' };
  if (!customerId) {
    return {
      ok: false,
      error: 'Не выбран контрагент: двигатели некуда добавить. Создайте контрагента в справочнике и вернитесь.',
    };
  }
  if (!contractId) {
    return {
      ok: false,
      error: 'Не выбран договор: двигатели некуда добавить. Создайте договор и вернитесь.',
    };
  }
  if (!Number.isFinite(arrivalDate) || arrivalDate <= 0) {
    return { ok: false, error: 'Не указана дата прихода — приём отменён.' };
  }
  if (rows.length === 0) return { ok: false, error: 'Список двигателей пуст.' };
  if (rows.length > ENGINE_BULK_INTAKE_MAX) {
    return {
      ok: false,
      error: `За один раз принимаем не больше ${ENGINE_BULK_INTAKE_MAX} номеров. Разделите список на части.`,
    };
  }

  const brandLabel = (await getDisplayNameMap(db, 'engine_brand')).get(brandId);
  if (!brandLabel) {
    return { ok: false, error: 'Марка двигателя не найдена в базе — обновите список и выберите заново.' };
  }
  const customerName = (await getDisplayNameMap(db, 'customer')).get(customerId);
  if (!customerName) {
    return { ok: false, error: 'Контрагент не найден в базе — обновите список и выберите заново.' };
  }
  const contractName = (await getDisplayNameMap(db, 'contract')).get(contractId);
  if (!contractName) {
    return { ok: false, error: 'Договор не найден в базе — обновите список и выберите заново.' };
  }
  const contractCustomerId = (await getContractCustomerMap(db)).get(contractId) ?? '';
  if (contractCustomerId && contractCustomerId !== customerId) {
    return {
      ok: false,
      error: `Договор «${contractName}» принадлежит другому контрагенту. Выберите договор этого контрагента.`,
    };
  }

  const engineTypeId = await entityTypeId(db, 'engine');
  if (!engineTypeId) return { ok: false, error: 'В базе нет типа сущности «двигатель» — обратитесь к администратору.' };

  const numbers = rows.map((row) => String(row?.number ?? '').trim()).filter(Boolean);
  const existingByKey = await loadEngineNumberIndex(db, numbers);

  let created = 0;
  let skipped = 0;
  const createdIds: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const number = String(row?.number ?? '').trim();
    if (!number) continue;
    const key = engineBulkIntakeKey(number);
    if (!key || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const action = row?.action === 'repeat_arrival' ? 'repeat_arrival' : row?.action === 'skip' ? 'skip' : 'create';
    const existing = existingByKey.get(key) ?? null;
    if (action === 'skip') {
      skipped += 1;
      continue;
    }
    if (action === 'create' && existing) {
      // Превью устарело (двигатель завели, пока оператор выбирал) — дубль не создаём.
      skipped += 1;
      continue;
    }
    const repeat = action === 'repeat_arrival';
    const previousEngineId = repeat
      ? String(row?.previousEngineId ?? '').trim() || existing?.id || ''
      : '';
    const engineId = randomUUID();
    const saved = await saveEngineCardGated(deps, engineId, {
      engine_number: number,
      engine_brand_id: brandId,
      engine_brand: brandLabel,
      customer_id: customerId,
      contract_id: contractId,
      arrival_date: arrivalDate,
      ...(repeat ? { repeat_arrival_flag: true, previous_arrival_id: previousEngineId || null } : {}),
    });
    if (!saved.ok) {
      return {
        ok: false,
        error:
          created > 0
            ? `Заведено ${created} из ${rows.length} карточек, дальше отказ: «${number}» — ${saved.error}`
            : `«${number}»: ${saved.error}`,
        created,
        createdIds,
      };
    }
    created += 1;
    createdIds.push(engineId);
  }
  return { ok: true, created, skipped, createdIds };
}
