import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_INVENTORY_STAGE,
  EntityTypeCode,
  STATUS_CODES,
  applyStatusFlagChange,
  normalizeLookupCompact,
  parseContractSections,
  searchLookupOptionsTiered,
  statusDateCode,
  type StatusCode,
} from '@matricarmz/shared';

import { attributeDefs, attributeValues, entities, entityTypes, operations } from '../database/schema.js';
import { listEntitiesByType } from './entityService.js';
import type { EngineDetails, EngineDuplicateCandidate, EngineDuplicateMatches, EngineListItem } from '@matricarmz/shared';

function nowMs() {
  return Date.now();
}

async function getEngineTypeId(db: BetterSQLite3Database): Promise<string> {
  const rows = await db.select().from(entityTypes).where(eq(entityTypes.code, EntityTypeCode.Engine)).limit(1);
  if (!rows[0]) throw new Error('Не найден entity_type "engine". Запустите seed.');
  return rows[0].id;
}

async function getEngineAttrDefs(db: BetterSQLite3Database): Promise<Record<string, string>> {
  const engineTypeId = await getEngineTypeId(db);
  const defs = await db.select().from(attributeDefs).where(eq(attributeDefs.entityTypeId, engineTypeId));
  const byCode: Record<string, string> = {};
  for (const d of defs) byCode[d.code] = d.id;
  return byCode;
}

async function getEntityTypeIdByCode(db: BetterSQLite3Database, code: string): Promise<string | null> {
  const rows = await db.select().from(entityTypes).where(eq(entityTypes.code, code)).limit(1);
  return rows[0]?.id ?? null;
}

async function getDisplayNameMap(db: BetterSQLite3Database, typeCode: string): Promise<Map<string, string>> {
  const typeId = await getEntityTypeIdByCode(db, typeCode);
  if (!typeId) return new Map();
  const items = await listEntitiesByType(db, typeId);
  return new Map(items.map((item) => [String(item.id), String(item.displayName ?? item.id)]));
}

async function getContractSignedAtMap(db: BetterSQLite3Database): Promise<Map<string, number>> {
  const typeId = await getEntityTypeIdByCode(db, EntityTypeCode.Contract);
  if (!typeId) return new Map();

  const contractRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, typeId), isNull(entities.deletedAt)))
    .limit(20_000);
  const contractIds = contractRows.map((row) => String(row.id)).filter(Boolean);
  if (contractIds.length === 0) return new Map();

  const contractDefs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)))
    .limit(5000);
  const contractSectionsDefId = contractDefs.find((row) => String(row.code) === 'contract_sections')?.id ?? null;
  const contractDateDefId = contractDefs.find((row) => String(row.code) === 'date')?.id ?? null;
  const defIds = [contractSectionsDefId, contractDateDefId].filter(Boolean) as string[];
  if (defIds.length === 0) return new Map();

  const valueRows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, contractIds),
        inArray(attributeValues.attributeDefId, defIds),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(200_000);

  const valuesByContract = new Map<string, Map<string, string | null>>();
  for (const row of valueRows) {
    const entityId = String(row.entityId);
    let map = valuesByContract.get(entityId);
    if (!map) {
      map = new Map<string, string | null>();
      valuesByContract.set(entityId, map);
    }
    map.set(String(row.attributeDefId), row.valueJson == null ? null : String(row.valueJson));
  }

  const out = new Map<string, number>();
  for (const contractId of contractIds) {
    const values = valuesByContract.get(contractId) ?? new Map<string, string | null>();
    let signedAt: number | null = null;

    if (contractSectionsDefId) {
      const sectionsRawValue = values.get(contractSectionsDefId);
      if (sectionsRawValue != null) {
        const sectionsRaw = safeJsonParse(sectionsRawValue);
        const sections = parseContractSections({ contract_sections: sectionsRaw });
        const fromSections = sections.primary.signedAt;
        if (typeof fromSections === 'number' && Number.isFinite(fromSections)) signedAt = fromSections;
      }
    }

    if (signedAt == null && contractDateDefId) {
      const dateRawValue = values.get(contractDateDefId);
      const dateRaw = dateRawValue != null ? safeJsonParse(dateRawValue) : null;
      const parsed = typeof dateRaw === 'number' ? dateRaw : dateRaw != null ? Number(dateRaw) : null;
      if (typeof parsed === 'number' && Number.isFinite(parsed)) signedAt = parsed;
    }

    if (signedAt != null) out.set(contractId, signedAt);
  }

  return out;
}

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toNonNegativeInteger(value: unknown): number | null {
  const n = safeNumber(value);
  if (n == null) return null;
  const next = Math.floor(n);
  return next >= 0 ? next : null;
}

// D-#9: авто-брак двигателя — деталь-картер ушла в утиль (scrap_qty>0) в списке деталей.
// Прочие детали в утиле не делают двигатель забракованным (см. PENDING §D). Имя картера
// узнаём по вхождению «картер» (без регистра) в part_name строки.
// Источник — стадия `engine_inventory` (таблица engine_inventory_items): checklist-unify
// (migrateChecklistToEngineInventory) объединил defect+completeness в неё и soft-delete'нул
// прежние defect-акты, поэтому читать надо именно её, иначе флаг всегда пуст (G: метка
// не снималась — читался опустевший defect-акт, а карточка пишет engine_inventory).
function isCrankcaseInventoryScrapped(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const answers = (payload as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object') return false;

  const inventoryItems = (answers as Record<string, unknown>).engine_inventory_items;
  if (!inventoryItems || typeof inventoryItems !== 'object') return false;
  const inventoryItemsObj = inventoryItems as { kind?: unknown; rows?: unknown[] };
  if (inventoryItemsObj.kind !== 'table') return false;
  if (!Array.isArray(inventoryItemsObj.rows)) return false;

  for (const rawRow of inventoryItemsObj.rows) {
    if (!rawRow || typeof rawRow !== 'object') continue;
    const row = rawRow as Record<string, unknown>;
    const name = String(row.part_name ?? '').toLowerCase();
    if (!name.includes('картер')) continue;
    const scrapQty = toNonNegativeInteger(row.scrap_qty);
    if (scrapQty != null && scrapQty > 0) return true;
  }

  return false;
}

async function getInventoryCrankcaseScrapMap(db: BetterSQLite3Database, engineIds: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (engineIds.length === 0) return result;

  const rows = await db
    .select({ engineEntityId: operations.engineEntityId, metaJson: operations.metaJson })
    .from(operations)
    .where(
      and(
        inArray(operations.engineEntityId, engineIds),
        eq(operations.operationType, ENGINE_INVENTORY_STAGE),
        isNull(operations.deletedAt),
      ),
    )
    .orderBy(desc(operations.updatedAt));

  const seen = new Set<string>();
  for (const row of rows as any[]) {
    const engineId = String(row?.engineEntityId ?? '').trim();
    if (!engineId || seen.has(engineId)) continue;
    seen.add(engineId);

    const payload = row.metaJson ? safeJsonParse(String(row.metaJson)) : null;
    result.set(engineId, isCrankcaseInventoryScrapped(payload));
  }

  return result;
}

export async function listEngines(db: BetterSQLite3Database): Promise<EngineListItem[]> {
  const engineTypeId = await getEngineTypeId(db);
  const engines = await db
    .select()
    .from(entities)
    .where(and(eq(entities.typeId, engineTypeId), isNull(entities.deletedAt)));

  const defs = await getEngineAttrDefs(db);
  const numberDefId = defs['engine_number'];
  const brandDefId = defs['engine_brand'];
  const brandIdDefId = defs['engine_brand_id'];
  const customerIdDefId = defs['customer_id'];
  const contractIdDefId = defs['contract_id'];
  const contractSectionDefId = defs['contract_section_number'];
  const arrivalDateDefId = defs['arrival_date'];
  const shippingDateDefId = defs['shipping_date'];
  const statusDateDefIds = STATUS_CODES.map((c) => defs[statusDateCode(c)]).filter(Boolean) as string[];
  const attachmentsDefId = defs['attachments'];
  const reclamationFlagDefId = defs['reclamation_flag'];
  const repeatArrivalDefId = defs['repeat_arrival_flag'];
  const numberCollisionDefId = defs['number_collision_flag'];
  const statusDefIds = STATUS_CODES.map((c) => defs[c]).filter(Boolean) as string[];

  const customerNameById = await getDisplayNameMap(db, EntityTypeCode.Customer);
  const contractNameById = await getDisplayNameMap(db, EntityTypeCode.Contract);
  const contractSignedAtById = await getContractSignedAtMap(db);
  const engineIds = engines.map((e) => e.id);
  const crankcaseScrapByEngineId = await getInventoryCrankcaseScrapMap(db, engineIds);
  const baseDefIds = [
    numberDefId,
    brandDefId,
    brandIdDefId,
    customerIdDefId,
    contractIdDefId,
    contractSectionDefId,
    arrivalDateDefId,
    shippingDateDefId,
    attachmentsDefId,
    reclamationFlagDefId,
    repeatArrivalDefId,
    numberCollisionDefId,
  ].filter(Boolean) as string[];
  const attrDefIds = [...new Set([...baseDefIds, ...statusDefIds, ...statusDateDefIds])];

  const valueRows =
    engineIds.length > 0 && attrDefIds.length > 0
      ? await db
          .select({
            entityId: attributeValues.entityId,
            attributeDefId: attributeValues.attributeDefId,
            valueJson: attributeValues.valueJson,
          })
          .from(attributeValues)
          .where(
            and(
              inArray(attributeValues.entityId, engineIds),
              inArray(attributeValues.attributeDefId, attrDefIds),
              isNull(attributeValues.deletedAt),
            ),
          )
          // Oldest→newest so the per-(entity,def) map keeps the NEWEST value if stray
          // duplicate rows exist (defensive; setEntityAttribute now collapses them).
          .orderBy(asc(attributeValues.updatedAt))
      : [];

  const valuesByEntity = new Map<string, Map<string, string | null>>();
  for (const row of valueRows) {
    const entityId = String(row.entityId);
    let map = valuesByEntity.get(entityId);
    if (!map) {
      map = new Map<string, string | null>();
      valuesByEntity.set(entityId, map);
    }
    map.set(String(row.attributeDefId), row.valueJson == null ? null : String(row.valueJson));
  }

  const statusDefById: Record<string, string> = {};
  for (const c of STATUS_CODES) {
    const id = defs[c];
    if (id) statusDefById[id] = c;
  }
  const statusDateDefById: Record<string, StatusCode> = {};
  for (const c of STATUS_CODES) {
    const dateDefId = defs[statusDateCode(c)];
    if (dateDefId) statusDateDefById[dateDefId] = c;
  }

  const result: EngineListItem[] = [];
  for (const e of engines) {
    const rowValues = valuesByEntity.get(e.id) ?? new Map<string, string | null>();
    let engineNumber: string | undefined;
    let engineBrand: string | undefined;
    let engineBrandId: string | undefined;
    let customerId: string | undefined;
    let contractId: string | undefined;
    let contractSectionNumber: string | undefined;
    let arrivalDate: number | null | undefined;
    let shippingDate: number | null | undefined;
    let attachmentPreviews: Array<{ id: string; name: string; mime: string | null }> = [];
    const statusDateByCode: Partial<Record<StatusCode, number | null>> = {};

    if (numberDefId) {
      const v = rowValues.get(numberDefId);
      engineNumber = v != null ? safeStringFromJson(v) : undefined;
    }
    if (brandDefId) {
      const v = rowValues.get(brandDefId);
      engineBrand = v != null ? safeStringFromJson(v) : undefined;
    }
    if (brandIdDefId) {
      const v = rowValues.get(brandIdDefId);
      engineBrandId = v != null ? safeStringFromJson(v) : undefined;
    }
    if (customerIdDefId) {
      const v = rowValues.get(customerIdDefId);
      customerId = v != null ? safeStringFromJson(v) : undefined;
    }
    if (contractIdDefId) {
      const v = rowValues.get(contractIdDefId);
      contractId = v != null ? safeStringFromJson(v) : undefined;
    }
    if (contractSectionDefId) {
      const v = rowValues.get(contractSectionDefId);
      contractSectionNumber = v != null ? safeStringFromJson(v) : undefined;
    }
    if (arrivalDateDefId) {
      const v = rowValues.get(arrivalDateDefId);
      const raw = v != null ? safeJsonParse(v) : null;
      arrivalDate = typeof raw === 'number' ? raw : raw ? Number(raw) : null;
    }
    let legacyShippingDate: number | null = null;
    if (shippingDateDefId) {
      const v = rowValues.get(shippingDateDefId);
      const raw = v != null ? safeJsonParse(v) : null;
      legacyShippingDate = typeof raw === 'number' ? raw : raw ? Number(raw) : null;
    }
    for (const statusDateDefId of statusDateDefIds) {
      const code = (statusDateDefById as Record<string, StatusCode | undefined>)[statusDateDefId];
      if (!code) continue;
      const rawValue = rowValues.get(statusDateDefId);
      const raw = rawValue != null ? safeJsonParse(rawValue) : null;
      const parsed = typeof raw === 'number' ? raw : raw ? Number(raw) : null;
      if (typeof parsed === 'number' && Number.isFinite(parsed)) statusDateByCode[code] = parsed;
      else statusDateByCode[code] = null;
    }
    if (attachmentsDefId) {
      const v = rowValues.get(attachmentsDefId);
      const raw = v != null ? safeJsonParse(v) : null;
      attachmentPreviews = toAttachmentPreviews(raw);
    }
    const boolAttr = (defIdMaybe: string | undefined): boolean => {
      if (!defIdMaybe) return false;
      const v = rowValues.get(defIdMaybe);
      const raw = v != null ? safeJsonParse(v) : null;
      return raw === true || raw === 'true' || raw === 1;
    };
    const isReclamation = boolAttr(reclamationFlagDefId);
    const isRepeatArrival = boolAttr(repeatArrivalDefId);
    const isNumberCollision = boolAttr(numberCollisionDefId);

    const statusFlags: Partial<Record<StatusCode, boolean>> = {};
    if (statusDefIds.length > 0) {
      for (const statusDefId of statusDefIds) {
        const code = (statusDefById as Record<string, StatusCode | undefined>)[statusDefId];
        if (code) {
          const rawValue = rowValues.get(statusDefId);
          const raw = rawValue != null ? safeJsonParse(rawValue) : null;
          statusFlags[code] = raw === true || raw === 'true' || raw === 1;
        }
      }
    }
    // Дата отгрузки в списке = статус-дата «Отправлен заказчику» (status_customer_sent) —
    // ровно то, что правит карточка. Прямой атрибут shipping_date — замороженный февральский
    // импорт-legacy (ни одной записи после 2026-02-26); читаем его ТОЛЬКО как исторический
    // фолбэк, когда статус-даты нет. Раньше список предпочитал legacy → навсегда показывал
    // импортное значение и игнорировал правки карточки (баг 2Ж03АТ0479; 172 расхождения на проде).
    if (statusDateByCode.status_customer_sent != null) {
      shippingDate = statusDateByCode.status_customer_sent;
    } else if (statusDateByCode.status_customer_accepted != null) {
      // Some historical cards have only the final customer acceptance date.
      shippingDate = statusDateByCode.status_customer_accepted;
    } else {
      shippingDate = legacyShippingDate;
    }
    const statusRejected = statusFlags.status_rejected === true;
    // D-#9: авто-брак по детали-картеру в утиле (источник — engine_inventory, см. выше).
    const crankcaseScrapped = crankcaseScrapByEngineId.get(e.id) === true;

    const customerName = customerId ? customerNameById.get(customerId) : undefined;
    const contractName = contractId ? contractNameById.get(contractId) : undefined;
    const contractSignedAt = contractId ? contractSignedAtById.get(contractId) : undefined;
    result.push({
      id: e.id,
      engineNumber: engineNumber ?? '',
      engineBrand: engineBrand ?? '',
      engineBrandId: engineBrandId ?? '',
      customerId: customerId ?? '',
      ...(customerName ? { customerName } : {}),
      contractId: contractId ?? '',
      ...(contractName ? { contractName } : {}),
      ...(contractSectionNumber ? { contractSectionNumber } : {}),
      arrivalDate: arrivalDate ?? null,
      shippingDate: shippingDate ?? null,
      // Утиль = живой флаг «Забракован» (status_rejected) ИЛИ картер в утиле (из engine_inventory).
      // Прямой legacy-атрибут is_scrap (замороженный февральский импорт, карточкой не правится)
      // намеренно НЕ читаем: его OR делал импортное true неисправимым из карточки — та же
      // dual-source-ловушка, что у shipping_date. На проде было лишь 2 таких, оба уже status_rejected.
      isScrap: statusRejected || crankcaseScrapped,
      ...(isReclamation ? { isReclamation: true } : {}),
      ...(isRepeatArrival ? { isRepeatArrival: true } : {}),
      ...(isNumberCollision ? { isNumberCollision: true } : {}),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      syncStatus: e.syncStatus,
      ...(typeof contractSignedAt === 'number' ? { contractSignedAt } : {}),
      ...(Object.keys(statusFlags).length > 0 && { statusFlags }),
      ...(attachmentPreviews.length > 0 ? { attachmentPreviews } : {}),
    });
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createEngine(_db: BetterSQLite3Database, _actor?: string): Promise<{ id: string }> {
  // Deferred create (no auto-empty cards, Phase 2): allocate the id but DO NOT insert a row.
  // The entity is materialized on the first setEngineAttribute, so an opened-then-abandoned
  // empty engine card never persists and never syncs. getEngineDetails synthesizes an empty
  // card for an id with no row yet. See docs/plans/drafts-no-empty-cards-recovery-2026-06.md.
  return { id: randomUUID() };
}

export async function getEngineDetails(db: BetterSQLite3Database, id: string): Promise<EngineDetails> {
  const e = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  if (!e[0]) {
    // Deferred create (Phase 2): no row yet for a freshly-created, not-yet-saved engine —
    // synthesize an empty card so it opens; the row is materialized on the first attribute write.
    const ts = nowMs();
    return {
      id,
      typeId: await getEngineTypeId(db),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
      attributes: {},
    };
  }

  const defs = await getEngineAttrDefs(db);
  const attr: Record<string, unknown> = {};
  for (const [code, defId] of Object.entries(defs)) {
    const v = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.entityId, id), eq(attributeValues.attributeDefId, defId)))
      .limit(1);
    if (v[0]?.valueJson) attr[code] = safeJsonParse(v[0].valueJson);
  }

  return {
    id: e[0].id,
    typeId: e[0].typeId,
    createdAt: e[0].createdAt,
    updatedAt: e[0].updatedAt,
    deletedAt: e[0].deletedAt ?? null,
    syncStatus: e[0].syncStatus,
    attributes: attr,
  };
}

/** Canonical uniqueness check: same compact engine number => same engine (see shared lookupNormalize). */
export async function findEngineDuplicateByNumber(
  db: BetterSQLite3Database,
  engineNumber: string,
  excludeEngineId?: string,
): Promise<{ id: string; engineNumber: string } | null> {
  const key = normalizeLookupCompact(String(engineNumber ?? ''));
  if (!key) return null;
  const defs = await getEngineAttrDefs(db);
  const numberDefId = defs['engine_number'];
  if (!numberDefId) return null;
  const rows = await db
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
  for (const r of rows) {
    const id = String(r.entityId);
    if (excludeEngineId && id === excludeEngineId) continue;
    const parsed = safeJsonParse(String(r.valueJson ?? ''));
    const num = typeof parsed === 'string' ? parsed.trim() : '';
    if (num && normalizeLookupCompact(num) === key) return { id, engineNumber: num };
  }
  return null;
}

/** Флаги осознанного дубля номера (Ф2): «повторный заезд» / «коллизия номера». */
export async function engineHasDuplicateBypassFlag(
  db: BetterSQLite3Database,
  engineId: string,
  defs: Record<string, string>,
): Promise<boolean> {
  const flagDefIds = ['repeat_arrival_flag', 'number_collision_flag'].map((c) => defs[c]).filter(Boolean) as string[];
  if (flagDefIds.length === 0) return false;
  const rows = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.entityId, engineId),
        inArray(attributeValues.attributeDefId, flagDefIds),
        isNull(attributeValues.deletedAt),
      ),
    );
  return rows.some((r) => {
    const parsed = safeJsonParse(String(r.valueJson ?? ''));
    return parsed === true || parsed === 'true' || parsed === 1;
  });
}

// Too-short numbers make substring search noise (every engine "matches" «1»).
const ENGINE_DUP_MIN_KEY_LEN = 3;
const ENGINE_DUP_SIMILAR_LIMIT = 6;

/**
 * Proactive duplicate hint for the engine card (#317): given the number being
 * typed, returns exact canonical-key matches (real duplicates) plus typo/near
 * matches via tiered search. The write-time gate (setEngineAttribute) blocks
 * exact dupes on save; this surfaces them earlier and adds the «похожие» tier.
 */
export async function findEngineDuplicateCandidates(
  db: BetterSQLite3Database,
  engineNumber: string,
  excludeEngineId?: string,
): Promise<EngineDuplicateMatches> {
  const raw = String(engineNumber ?? '').trim();
  const key = normalizeLookupCompact(raw);
  if (key.length < ENGINE_DUP_MIN_KEY_LEN) return { exact: [], similar: [] };

  const defs = await getEngineAttrDefs(db);
  const numberDefId = defs['engine_number'];
  const brandDefId = defs['engine_brand'];
  if (!numberDefId) return { exact: [], similar: [] };

  const engineTypeId = await getEngineTypeId(db);
  const engineRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, engineTypeId), isNull(entities.deletedAt)))
    .limit(200_000);
  const engineIds = engineRows.map((r) => String(r.id)).filter((id) => id !== excludeEngineId);
  if (engineIds.length === 0) return { exact: [], similar: [] };

  const wantedDefIds = [numberDefId, brandDefId].filter(Boolean) as string[];
  const valueRows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, engineIds),
        inArray(attributeValues.attributeDefId, wantedDefIds),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(500_000);

  const numberById = new Map<string, string>();
  const brandById = new Map<string, string>();
  for (const r of valueRows) {
    const eid = String(r.entityId);
    const val = r.valueJson != null ? safeStringFromJson(String(r.valueJson)) : undefined;
    if (val == null) continue;
    if (String(r.attributeDefId) === numberDefId) numberById.set(eid, val);
    else if (brandDefId && String(r.attributeDefId) === brandDefId) brandById.set(eid, val);
  }

  const exact: EngineDuplicateCandidate[] = [];
  const options: Array<{ id: string; label: string; hintText: string; candidate: EngineDuplicateCandidate }> = [];
  for (const [eid, num] of numberById) {
    const trimmed = num.trim();
    if (!trimmed) continue;
    const candidate: EngineDuplicateCandidate = {
      id: eid,
      engineNumber: trimmed,
      engineBrand: (brandById.get(eid) ?? '').trim(),
    };
    if (normalizeLookupCompact(trimmed) === key) exact.push(candidate);
    options.push({ id: eid, label: trimmed, hintText: candidate.engineBrand, candidate });
  }

  const exactIds = new Set(exact.map((c) => c.id));
  const tiered = searchLookupOptionsTiered(
    options.filter((o) => !exactIds.has(o.id)),
    raw,
  );
  const ranked = tiered.primary.length > 0 ? tiered.primary : tiered.similar;
  const similar = ranked.slice(0, ENGINE_DUP_SIMILAR_LIMIT).map((o) => o.candidate);

  return { exact, similar };
}

export async function setEngineAttribute(
  db: BetterSQLite3Database,
  engineId: string,
  code: string,
  value: unknown,
  _actor?: string,
) {
  const ts = nowMs();
  const defs = await getEngineAttrDefs(db);
  const defId = defs[code];
  if (!defId) throw new Error(`Неизвестный атрибут двигателя: ${code}`);

  if (code === 'engine_number') {
    const dup = await findEngineDuplicateByNumber(db, String(value ?? ''), engineId);
    // Осознанный дубль (повторный заезд / коллизия номера, Ф2): флаг на этой сущности
    // снимает запрет. Карточка пишет флаги ДО номера (порядок в saveAllAndClose),
    // поэтому к моменту проверки флаг уже записан локально.
    if (dup && !(await engineHasDuplicateBypassFlag(db, engineId, defs))) {
      throw new Error(`Двигатель с номером «${dup.engineNumber}» уже существует. Откройте его карточку вместо создания дубля.`);
    }
  }

  // Deferred create (Phase 2): materialize the entity row on the first attribute write —
  // createEngine no longer inserts, so an empty card that's never edited leaves no ghost.
  const ent = await db.select({ id: entities.id }).from(entities).where(eq(entities.id, engineId)).limit(1);
  if (!ent[0]) {
    await db.insert(entities).values({
      id: engineId,
      typeId: await getEngineTypeId(db),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
  }

  // Update the NEWEST non-deleted row and collapse any other active duplicates so a
  // single active value remains (mirrors setEntityAttribute). The old code matched by
  // (engine, attr) WITHOUT a deletedAt filter or ordering and took limit(1) — with
  // duplicate/soft-deleted rows it updated an arbitrary one, so the engines LIST (which
  // reads a non-deleted value) could keep showing a stale duplicate after a card edit.
  const active = await db
    .select()
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.entityId, engineId),
        eq(attributeValues.attributeDefId, defId),
        isNull(attributeValues.deletedAt),
      ),
    )
    .orderBy(desc(attributeValues.updatedAt));

  const payload = JSON.stringify(value);
  if (active[0]) {
    await db
      .update(attributeValues)
      .set({ valueJson: payload, updatedAt: ts, deletedAt: null, syncStatus: 'pending' })
      .where(eq(attributeValues.id, active[0].id));
    for (const dup of active.slice(1)) {
      await db
        .update(attributeValues)
        .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' })
        .where(eq(attributeValues.id, dup.id));
    }
  } else {
    await db.insert(attributeValues).values({
      id: randomUUID(),
      entityId: engineId,
      attributeDefId: defId,
      valueJson: payload,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
  }

  // Обновляем updated_at у сущности.
  await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, engineId));
  // IMPORTANT: do NOT write audit_log on each attribute change.
  // EngineDetailsPage saves many fields; high-level audit is recorded when the user finishes editing.
}

export type AssemblyEngineStatusTarget = 'status_repair_started' | 'status_repaired';

/**
 * Ф2: авто-переход статуса двигателя из сборочного наряда. «Только вперёд» —
 * `status_repair_started` не ставится, если двигатель уже отремонтирован/отгружен/принят
 * заказчиком (не откатываем более поздний статус назад). Взаимоисключение флагов —
 * через общий `applyStatusFlagChange` (тот же, что у ручного тумблера карточки).
 * Пишет только изменившиеся флаги + дату целевого статуса. Идемпотентно.
 */
export async function advanceEngineStatusForWorkOrder(
  db: BetterSQLite3Database,
  engineId: string,
  target: AssemblyEngineStatusTarget,
  dateMs: number,
  actor?: string,
): Promise<{ applied: boolean; reason?: string }> {
  const id = String(engineId ?? '').trim();
  if (!id) return { applied: false, reason: 'no-engine' };

  const details = await getEngineDetails(db, id);
  const attrs = details.attributes ?? {};
  const current: Partial<Record<StatusCode, boolean>> = {};
  for (const code of STATUS_CODES) current[code] = attrs[code] === true;

  if (target === 'status_repair_started') {
    if (current.status_repaired || current.status_customer_sent || current.status_customer_accepted) {
      return { applied: false, reason: 'already-advanced' };
    }
    if (current.status_repair_started) return { applied: false, reason: 'already-set' };
  }

  const nextFlags = applyStatusFlagChange(current, target, true);
  for (const code of STATUS_CODES) {
    if ((current[code] ?? false) !== (nextFlags[code] ?? false)) {
      await setEngineAttribute(db, id, code, nextFlags[code] === true, actor);
    }
  }
  const validDate = Number.isFinite(dateMs) && dateMs > 0 ? dateMs : nowMs();
  await setEngineAttribute(db, id, statusDateCode(target), validDate, actor);

  return { applied: true };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function safeStringFromJson(s: string): string | undefined {
  const v = safeJsonParse(s);
  if (typeof v === 'string') return v;
  if (v == null) return undefined;
  return String(v);
}

function toAttachmentPreviews(raw: unknown): Array<{ id: string; name: string; mime: string | null }> {
  if (!Array.isArray(raw)) return [];
  const previews: Array<{ id: string; name: string; mime: string | null }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.isObsolete === true) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name) continue;
    const mime = typeof entry.mime === 'string' ? entry.mime : null;
    previews.push({ id, name, mime });
    if (previews.length >= 5) break;
  }
  return previews;
}


