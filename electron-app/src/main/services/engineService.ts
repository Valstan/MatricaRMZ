import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { EntityTypeCode, STATUS_CODES, type StatusCode } from '@matricarmz/shared';

import { attributeDefs, attributeValues, auditLog, entities, entityTypes } from '../database/schema.js';
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
  const scrapDefId = defs['is_scrap'];
  const statusDefIds = STATUS_CODES.map((c) => defs[c]).filter(Boolean) as string[];

  const customerNameById = await getDisplayNameMap(db, EntityTypeCode.Customer);
  const contractNameById = await getDisplayNameMap(db, EntityTypeCode.Contract);

  const engineIds = engines.map((e) => e.id);
  const baseDefIds = [
    numberDefId,
    brandDefId,
    brandIdDefId,
    customerIdDefId,
    contractIdDefId,
    arrivalDateDefId,
    shippingDateDefId,
    scrapDefId,
  ].filter(Boolean) as string[];
  const attrDefIds = [...new Set([...baseDefIds, ...statusDefIds])];

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
    if (scrapDefId) {
      const v = rowValues.get(scrapDefId);
      const raw = v != null ? safeJsonParse(v) : null;
      isScrap = raw === true || raw === 'true' || raw === 1;
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

    const customerName = customerId ? customerNameById.get(customerId) : undefined;
    const contractName = contractId ? contractNameById.get(contractId) : undefined;
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
      isScrap: isScrap === true,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      syncStatus: e.syncStatus,
      ...(Object.keys(statusFlags).length > 0 && { statusFlags }),
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


