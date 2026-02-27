import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  EntityTypeCode,
  STATUS_CODES,
  parseContractSections,
  statusDateCode,
  type StatusCode,
} from '@matricarmz/shared';

import { attributeDefs, attributeValues, auditLog, entities, entityTypes, operations } from '../database/schema.js';
import { listEntitiesByType } from './entityService.js';
import type { EngineDetails, EngineListItem } from '@matricarmz/shared';

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

function isDefectItemsFullyScrapped(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const answers = (payload as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object') return false;

  const defectItems = (answers as Record<string, unknown>).defect_items;
  if (!defectItems || typeof defectItems !== 'object') return false;
  const defectItemsObj = defectItems as { kind?: unknown; rows?: unknown[] };
  if (defectItemsObj.kind !== 'table') return false;
  if (!Array.isArray(defectItemsObj.rows)) return false;

  const rows = defectItemsObj.rows;
  let hasRows = false;
  for (const rawRow of rows) {
    if (!rawRow || typeof rawRow !== 'object') continue;

    const row = rawRow as Record<string, unknown>;
    const quantity = toNonNegativeInteger(row.quantity);
    if (quantity == null || quantity <= 0) continue;
    hasRows = true;

    const repairableQty = toNonNegativeInteger(row.repairable_qty);
    const scrapQty = toNonNegativeInteger(row.scrap_qty);

    if (repairableQty != null) {
      if (repairableQty !== 0) return false;
      continue;
    }

    if (scrapQty == null || scrapQty < quantity) return false;
  }

  return hasRows;
}

async function getDefectChecklistScrapMap(db: BetterSQLite3Database, engineIds: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (engineIds.length === 0) return result;

  const rows = await db
    .select({ engineEntityId: operations.engineEntityId, metaJson: operations.metaJson })
    .from(operations)
    .where(
      and(
        inArray(operations.engineEntityId, engineIds),
        eq(operations.operationType, 'defect'),
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
    result.set(engineId, isDefectItemsFullyScrapped(payload));
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
  const arrivalDateDefId = defs['arrival_date'];
  const shippingDateDefId = defs['shipping_date'];
  const statusDateDefIds = STATUS_CODES.map((c) => defs[statusDateCode(c)]).filter(Boolean) as string[];
  const scrapDefId = defs['is_scrap'];
  const attachmentsDefId = defs['attachments'];
  const statusDefIds = STATUS_CODES.map((c) => defs[c]).filter(Boolean) as string[];

  const customerNameById = await getDisplayNameMap(db, EntityTypeCode.Customer);
  const contractNameById = await getDisplayNameMap(db, EntityTypeCode.Contract);
  const contractSignedAtById = await getContractSignedAtMap(db);
  const engineIds = engines.map((e) => e.id);
  const defectScrapByEngineId = await getDefectChecklistScrapMap(db, engineIds);
  const baseDefIds = [
    numberDefId,
    brandDefId,
    brandIdDefId,
    customerIdDefId,
    contractIdDefId,
    arrivalDateDefId,
    shippingDateDefId,
    scrapDefId,
    attachmentsDefId,
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
    let arrivalDate: number | null | undefined;
    let shippingDate: number | null | undefined;
    let isScrap: boolean | undefined;
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
    if (arrivalDateDefId) {
      const v = rowValues.get(arrivalDateDefId);
      const raw = v != null ? safeJsonParse(v) : null;
      arrivalDate = typeof raw === 'number' ? raw : raw ? Number(raw) : null;
    }
    if (shippingDateDefId) {
      const v = rowValues.get(shippingDateDefId);
      const raw = v != null ? safeJsonParse(v) : null;
      shippingDate = typeof raw === 'number' ? raw : raw ? Number(raw) : null;
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
    if (scrapDefId) {
      const v = rowValues.get(scrapDefId);
      const raw = v != null ? safeJsonParse(v) : null;
      isScrap = raw === true || raw === 'true' || raw === 1;
    }
    if (attachmentsDefId) {
      const v = rowValues.get(attachmentsDefId);
      const raw = v != null ? safeJsonParse(v) : null;
      attachmentPreviews = toAttachmentPreviews(raw);
    }

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
    if (shippingDate == null && statusDateByCode.status_customer_sent != null) {
      shippingDate = statusDateByCode.status_customer_sent;
    }
    const statusRejected = statusFlags.status_rejected === true;
    const allDefectPartsScrapped = defectScrapByEngineId.get(e.id) === true;

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
      arrivalDate: arrivalDate ?? null,
      shippingDate: shippingDate ?? null,
      isScrap: isScrap === true || statusRejected || allDefectPartsScrapped,
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

export async function createEngine(db: BetterSQLite3Database, actor?: string): Promise<{ id: string }> {
  const ts = nowMs();
  const engineTypeId = await getEngineTypeId(db);
  const id = randomUUID();
  await db.insert(entities).values({
    id,
    typeId: engineTypeId,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });

  await db.insert(auditLog).values({
    id: randomUUID(),
    actor: actor?.trim() ? actor.trim() : 'local',
    action: 'engine.create',
    entityId: id,
    tableName: 'entities',
    payloadJson: JSON.stringify({ engineId: id }),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
  return { id };
}

export async function getEngineDetails(db: BetterSQLite3Database, id: string): Promise<EngineDetails> {
  const e = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  if (!e[0]) throw new Error('Двигатель не найден');

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

  const existing = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, engineId), eq(attributeValues.attributeDefId, defId)))
    .limit(1);

  const payload = JSON.stringify(value);
  if (existing[0]) {
    await db
      .update(attributeValues)
      .set({ valueJson: payload, updatedAt: ts, deletedAt: null, syncStatus: 'pending' })
      .where(eq(attributeValues.id, existing[0].id));
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


