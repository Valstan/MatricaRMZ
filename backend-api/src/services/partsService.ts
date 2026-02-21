import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import { AttributeDataType, EntityTypeCode, SyncTableName, STATUS_CODES, type StatusCode } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { changeRequests, rowOwners, attributeDefs, attributeValues, auditLog, entities, entityTypes } from '../database/schema.js';
import type { AuthUser } from '../auth/jwt.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

function nowMs() {
  return Date.now();
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function toValueJson(value: unknown): string | null {
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return json;
}

function syncActor(actor?: { id?: string; username?: string; role?: string }) {
  return {
    id: String(actor?.id ?? 'system'),
    username: String(actor?.username ?? 'system'),
    role: String(actor?.role ?? 'system'),
  };
}

function entityTypePayload(row: {
  id: string;
  code: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function entityPayload(row: {
  id: string;
  typeId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    type_id: String(row.typeId),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function attributeDefPayload(row: {
  id: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  metaJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    entity_type_id: String(row.entityTypeId),
    code: String(row.code),
    name: String(row.name),
    data_type: String(row.dataType),
    is_required: Boolean(row.isRequired),
    sort_order: Number(row.sortOrder ?? 0),
    meta_json: row.metaJson == null ? null : String(row.metaJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function attributeValuePayload(row: {
  id: string;
  entityId: string;
  attributeDefId: string;
  valueJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    entity_id: String(row.entityId),
    attribute_def_id: String(row.attributeDefId),
    value_json: row.valueJson == null ? null : String(row.valueJson),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function auditLogPayload(row: {
  id: string;
  actor: string;
  action: string;
  entityId: string | null;
  tableName: string | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    actor: String(row.actor),
    action: String(row.action),
    entity_id: row.entityId ?? null,
    table_name: row.tableName ?? null,
    payload_json: row.payloadJson ?? null,
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function normalizeValueForCompare(valueJson: string | null | undefined): string | null {
  if (valueJson == null) return null;
  const parsed = safeJsonParse(String(valueJson));
  if (parsed == null) return null;
  if (typeof parsed === 'string') {
    if (parsed.trim() === '') return null;
    return JSON.stringify(parsed);
  }
  if (Array.isArray(parsed) && parsed.length === 0) return null;
  return JSON.stringify(parsed);
}

function normalizeSearch(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

async function getPartEntityTypeId(): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(eq(entityTypes.code, EntityTypeCode.Part))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function ensurePartAttributeDefs(partTypeId: string): Promise<void> {
  // Important: UI renders fields based on attribute_defs. If none exist, the Part card looks "empty".
  const existing = await db
    .select({ code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, partTypeId), isNull(attributeDefs.deletedAt)))
    .limit(10_000);
  const have = new Set(existing.map((r) => String(r.code)));

  const ts = nowMs();
  async function ensure(code: string, name: string, dataType: string, sortOrder: number, metaJson?: string | null) {
    if (have.has(code)) return;
    const id = randomUUID();
    await db.insert(attributeDefs).values({
      id,
      entityTypeId: partTypeId,
      code,
      name,
      dataType,
      isRequired: false,
      sortOrder,
      metaJson: metaJson ?? null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await recordSyncChanges(syncActor(), [
      {
        tableName: SyncTableName.AttributeDefs,
        rowId: id,
        op: 'upsert',
        payload: attributeDefPayload({
          id,
          entityTypeId: partTypeId,
          code,
          name,
          dataType,
          isRequired: false,
          sortOrder,
          metaJson: metaJson ?? null,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'synced',
        }),
        ts,
      },
    ]);
    have.add(code);
  }

  // Base fields (MVP) + required buckets for the redesigned UI.
  await ensure('name', 'Название', AttributeDataType.Text, 10);
  await ensure('article', 'Артикул / обозначение', AttributeDataType.Text, 20);
  await ensure('description', 'Описание', AttributeDataType.Text, 30);
  await ensure('assembly_unit_number', 'Номер сборочной единицы', AttributeDataType.Text, 35);

  // Links
  await ensure('engine_brand_ids', 'Марки двигателя', AttributeDataType.Json, 40); // string[] of engine_brand ids
  await ensure('engine_brand_qty_map', 'Количество по маркам двигателя', AttributeDataType.Json, 41); // Record<brandId, qty>
  await ensure('engine_node_id', 'Узел двигателя', AttributeDataType.Link, 45, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.EngineNode }));

  // Purchase
  await ensure('purchase_date', 'Дата покупки', AttributeDataType.Date, 50);
  await ensure('supplier_id', 'Поставщик', AttributeDataType.Link, 59, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Customer }));
  await ensure('supplier', 'Поставщик (legacy)', AttributeDataType.Text, 60);

  // Files (stored as FileRef[] in json)
  await ensure('drawings', 'Чертежи', AttributeDataType.Json, 200);
  await ensure('tech_docs', 'Технология', AttributeDataType.Json, 210);
  await ensure('attachments', 'Вложения', AttributeDataType.Json, 9990);
}

async function ensurePartEntityType(): Promise<string> {
  const existing = await getPartEntityTypeId();
  if (existing) {
    await ensurePartAttributeDefs(existing);
    return existing;
  }

  const id = randomUUID();
  const ts = nowMs();
  await db.insert(entityTypes).values({
    id,
    code: EntityTypeCode.Part,
    name: 'Деталь',
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });

  await recordSyncChanges(syncActor(), [
    {
      tableName: SyncTableName.EntityTypes,
      rowId: id,
      op: 'upsert',
      payload: entityTypePayload({
        id,
        code: EntityTypeCode.Part,
        name: 'Деталь',
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      }),
      ts,
    },
  ]);

  await ensurePartAttributeDefs(id);
  return id;
}

async function findPartDuplicateId(args: {
  typeId: string;
  attrDefs: { id: string; code: string }[];
  attributes?: Record<string, unknown>;
}): Promise<string | null> {
  const nameDef = args.attrDefs.find((d) => String(d.code) === 'name');
  if (!nameDef) return null;
  const nameValueJson = toValueJson(args.attributes?.name);
  if (!normalizeValueForCompare(nameValueJson)) return null;
  const nameValueCondition = nameValueJson == null ? isNull(attributeValues.valueJson) : eq(attributeValues.valueJson, nameValueJson);

  const candidates = await db
    .select({ entityId: attributeValues.entityId })
    .from(attributeValues)
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(attributeValues.attributeDefId, nameDef.id),
        nameValueCondition,
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        eq(entities.typeId, args.typeId),
      ),
    )
    .limit(5000);
  const candidateIds = candidates.map((r) => String(r.entityId));
  if (candidateIds.length === 0) return null;

  const defIds = args.attrDefs.map((d) => String(d.id));
  const candidateValues = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, candidateIds as any),
        inArray(attributeValues.attributeDefId, defIds as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(200_000);

  const currentNormalized = new Map<string, string | null>();
  for (const def of args.attrDefs) {
    const valueJson = toValueJson(args.attributes?.[def.code]);
    currentNormalized.set(String(def.id), normalizeValueForCompare(valueJson));
  }

  const valuesByEntity = new Map<string, Map<string, string | null>>();
  for (const row of candidateValues as any[]) {
    const eid = String(row.entityId);
    const map = valuesByEntity.get(eid) ?? new Map<string, string | null>();
    map.set(String(row.attributeDefId), row.valueJson == null ? null : String(row.valueJson));
    valuesByEntity.set(eid, map);
  }

  for (const candidateId of candidateIds) {
    const map = valuesByEntity.get(candidateId) ?? new Map<string, string | null>();
    let matches = true;
    for (const def of args.attrDefs) {
      const a = currentNormalized.get(String(def.id)) ?? null;
      const b = normalizeValueForCompare(map.get(String(def.id)) ?? null);
      if (a !== b) {
        matches = false;
        break;
      }
    }
    if (matches) return candidateId;
  }

  return null;
}

async function findPartDuplicateOnUpdate(args: {
  partId: string;
  typeId: string;
  attrDefs: { id: string; code: string }[];
  nextDefId: string;
  nextValueJson: string | null;
}): Promise<string | null> {
  const nameDef = args.attrDefs.find((d) => String(d.code) === 'name');
  if (!nameDef) return null;

  const defIds = args.attrDefs.map((d) => String(d.id));
  const currentValues = await db
    .select({ attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, args.partId), inArray(attributeValues.attributeDefId, defIds as any), isNull(attributeValues.deletedAt)))
    .limit(50_000);

  const valueByDefId = new Map<string, string | null>();
  for (const row of currentValues as any[]) {
    valueByDefId.set(String(row.attributeDefId), row.valueJson == null ? null : String(row.valueJson));
  }
  valueByDefId.set(args.nextDefId, args.nextValueJson);

  const labelValueJson = valueByDefId.get(String(nameDef.id)) ?? null;
  if (!normalizeValueForCompare(labelValueJson)) return null;
  const labelValueCondition =
    labelValueJson == null ? isNull(attributeValues.valueJson) : eq(attributeValues.valueJson, labelValueJson);

  const candidates = await db
    .select({ entityId: attributeValues.entityId })
    .from(attributeValues)
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(attributeValues.attributeDefId, nameDef.id),
        labelValueCondition,
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        eq(entities.typeId, args.typeId),
      ),
    )
    .limit(5000);
  const candidateIds = candidates.map((r) => String(r.entityId)).filter((id) => id !== args.partId);
  if (candidateIds.length === 0) return null;

  const candidateValues = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, candidateIds as any),
        inArray(attributeValues.attributeDefId, defIds as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(200_000);

  const currentNormalized = new Map<string, string | null>();
  for (const defId of defIds) {
    currentNormalized.set(defId, normalizeValueForCompare(valueByDefId.get(defId) ?? null));
  }

  const valuesByEntity = new Map<string, Map<string, string | null>>();
  for (const row of candidateValues as any[]) {
    const eid = String(row.entityId);
    const map = valuesByEntity.get(eid) ?? new Map<string, string | null>();
    map.set(String(row.attributeDefId), row.valueJson == null ? null : String(row.valueJson));
    valuesByEntity.set(eid, map);
  }

  for (const candidateId of candidateIds) {
    const map = valuesByEntity.get(candidateId) ?? new Map<string, string | null>();
    let matches = true;
    for (const defId of defIds) {
      const a = currentNormalized.get(defId) ?? null;
      const b = normalizeValueForCompare(map.get(defId) ?? null);
      if (a !== b) {
        matches = false;
        break;
      }
    }
    if (matches) return candidateId;
  }

  return null;
}

export async function createPartAttributeDef(args: {
  actor: AuthUser;
  code: string;
  name: string;
  dataType: string;
  isRequired?: boolean;
  sortOrder?: number;
  metaJson?: string | null;
}): Promise<
  | {
      ok: true;
      id: string;
    }
  | { ok: false; error: string }
> {
  try {
    const typeId = await ensurePartEntityType();
    const ts = nowMs();

    const code = String(args.code ?? '').trim();
    const name = String(args.name ?? '').trim();
    const dataType = String(args.dataType ?? '').trim();
    const sortOrder = Number(args.sortOrder ?? 0) || 0;
    const isRequired = args.isRequired === true;
    const metaJson = args.metaJson == null ? null : String(args.metaJson);

    if (!code) return { ok: false, error: 'code is empty' };
    if (!name) return { ok: false, error: 'name is empty' };
    if (!dataType) return { ok: false, error: 'dataType is empty' };

    const existing = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
      .limit(1);
    if (existing[0]?.id) {
      return { ok: false, error: `attribute already exists: ${code}` };
    }

    const id = randomUUID();
    await db.insert(attributeDefs).values({
      id,
      entityTypeId: typeId,
      code,
      name,
      dataType,
      isRequired,
      sortOrder,
      metaJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await recordSyncChanges(syncActor(args.actor), [
      {
        tableName: SyncTableName.AttributeDefs,
        rowId: id,
        op: 'upsert',
        payload: attributeDefPayload({
          id,
          entityTypeId: typeId,
          code,
          name,
          dataType,
          isRequired,
          sortOrder,
          metaJson,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'synced',
        }),
        ts,
      },
    ]);

    const auditId = randomUUID();
    await db.insert(auditLog).values({
      id: auditId,
      actor: args.actor.username,
      action: 'part.attribute_def.create',
      entityId: null,
      tableName: 'attribute_defs',
      payloadJson: JSON.stringify({ entityTypeCode: EntityTypeCode.Part, entityTypeId: typeId, attributeDefId: id, code, name, dataType }),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    await recordSyncChanges(syncActor(args.actor), [
      {
        tableName: SyncTableName.AuditLog,
        rowId: auditId,
        op: 'upsert',
        payload: auditLogPayload({
          id: auditId,
          actor: args.actor.username,
          action: 'part.attribute_def.create',
          entityId: null,
          tableName: 'attribute_defs',
          payloadJson: JSON.stringify({ entityTypeCode: EntityTypeCode.Part, entityTypeId: typeId, attributeDefId: id, code, name, dataType }),
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        }),
        ts,
      },
    ]);

    await db
      .insert(rowOwners)
      .values({
        id: randomUUID(),
        tableName: SyncTableName.AttributeDefs,
        rowId: id,
        ownerUserId: args.actor.id,
        ownerUsername: args.actor.username,
        createdAt: ts,
      })
      .onConflictDoNothing();

    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listParts(args?: { q?: string; limit?: number; engineBrandId?: string }): Promise<
  | {
      ok: true;
      parts: {
        id: string;
        name?: string;
        article?: string;
        assemblyUnitNumber?: string;
        engineBrandQtyMap?: Record<string, number>;
        engineBrandQty?: number;
        updatedAt: number;
        createdAt: number;
      }[];
    }
  | { ok: false; error: string }
> {
  try {
    const typeId = await ensurePartEntityType();
    const limit = args?.limit ?? 1000;
    const qNorm = args?.q ? normalizeSearch(args.q) : '';
    const engineBrandId = args?.engineBrandId ? String(args.engineBrandId).trim() : '';

    // Получаем все сущности типа Part
    const entityRows = await db
      .select({ id: entities.id, createdAt: entities.createdAt, updatedAt: entities.updatedAt })
      .from(entities)
      .where(and(eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .orderBy(desc(entities.updatedAt))
      .limit(limit);

    if (!entityRows.length) {
      return { ok: true, parts: [] };
    }

    // Получаем атрибуты для поиска (name, article)
    const nameAttr = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, 'name')))
      .limit(1);
    const articleAttr = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, 'article')))
      .limit(1);
    const brandAttr = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, 'engine_brand_ids')))
      .limit(1);
    const assemblyAttr = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, 'assembly_unit_number')))
      .limit(1);
    const brandQtyMapAttr = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, 'engine_brand_qty_map')))
      .limit(1);

    const nameAttrId = nameAttr[0]?.id;
    const articleAttrId = articleAttr[0]?.id;
    const brandAttrId = brandAttr[0]?.id;
    const assemblyAttrId = assemblyAttr[0]?.id;
    const brandQtyMapAttrId = brandQtyMapAttr[0]?.id;

    const entityIds = entityRows.map((r) => r.id);
    
    const attrRows = nameAttrId || articleAttrId || assemblyAttrId || brandQtyMapAttrId
      ? await db
          .select({
            entityId: attributeValues.entityId,
            attributeDefId: attributeValues.attributeDefId,
            valueJson: attributeValues.valueJson,
          })
          .from(attributeValues)
          .where(
            and(
              nameAttrId && articleAttrId && assemblyAttrId && brandQtyMapAttrId
                ? or(
                    eq(attributeValues.attributeDefId, nameAttrId),
                    eq(attributeValues.attributeDefId, articleAttrId),
                    eq(attributeValues.attributeDefId, assemblyAttrId),
                    eq(attributeValues.attributeDefId, brandQtyMapAttrId),
                  )
                : nameAttrId && articleAttrId && brandQtyMapAttrId
                  ? or(
                      eq(attributeValues.attributeDefId, nameAttrId),
                      eq(attributeValues.attributeDefId, articleAttrId),
                      eq(attributeValues.attributeDefId, brandQtyMapAttrId),
                    )
                  : nameAttrId && assemblyAttrId && brandQtyMapAttrId
                    ? or(
                        eq(attributeValues.attributeDefId, nameAttrId),
                        eq(attributeValues.attributeDefId, assemblyAttrId),
                        eq(attributeValues.attributeDefId, brandQtyMapAttrId),
                      )
                    : articleAttrId && assemblyAttrId && brandQtyMapAttrId
                      ? or(
                          eq(attributeValues.attributeDefId, articleAttrId),
                          eq(attributeValues.attributeDefId, assemblyAttrId),
                          eq(attributeValues.attributeDefId, brandQtyMapAttrId),
                        )
                : nameAttrId && articleAttrId
                  ? or(eq(attributeValues.attributeDefId, nameAttrId), eq(attributeValues.attributeDefId, articleAttrId))
                  : nameAttrId && assemblyAttrId
                    ? or(eq(attributeValues.attributeDefId, nameAttrId), eq(attributeValues.attributeDefId, assemblyAttrId))
                : nameAttrId && brandQtyMapAttrId
                  ? or(eq(attributeValues.attributeDefId, nameAttrId), eq(attributeValues.attributeDefId, brandQtyMapAttrId))
                    : articleAttrId && assemblyAttrId
                      ? or(eq(attributeValues.attributeDefId, articleAttrId), eq(attributeValues.attributeDefId, assemblyAttrId))
                : articleAttrId && brandQtyMapAttrId
                  ? or(eq(attributeValues.attributeDefId, articleAttrId), eq(attributeValues.attributeDefId, brandQtyMapAttrId))
                : assemblyAttrId && brandQtyMapAttrId
                  ? or(eq(attributeValues.attributeDefId, assemblyAttrId), eq(attributeValues.attributeDefId, brandQtyMapAttrId))
                      : nameAttrId
                        ? eq(attributeValues.attributeDefId, nameAttrId)
                        : articleAttrId
                          ? eq(attributeValues.attributeDefId, articleAttrId)
                : assemblyAttrId
                  ? eq(attributeValues.attributeDefId, assemblyAttrId)
                  : eq(attributeValues.attributeDefId, brandQtyMapAttrId!),
              inArray(attributeValues.entityId, entityIds),
              isNull(attributeValues.deletedAt),
            ),
          )
          .limit(10_000)
      : [];

    const brandRows = brandAttrId
      ? await db
          .select({
            entityId: attributeValues.entityId,
            valueJson: attributeValues.valueJson,
          })
          .from(attributeValues)
          .where(and(eq(attributeValues.attributeDefId, brandAttrId), inArray(attributeValues.entityId, entityIds), isNull(attributeValues.deletedAt)))
          .limit(10_000)
      : [];

    // contract_id and status flags for progress aggregation
    const contractIdAttr = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, 'contract_id')))
      .limit(1);
    const contractIdDefId = contractIdAttr[0]?.id;
    const statusDefRows = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), inArray(attributeDefs.code, [...STATUS_CODES])))
      .limit(10);
    const statusDefById = new Map(statusDefRows.map((r) => [r.id, r.code]));
    const extraDefIds = [...(contractIdDefId ? [contractIdDefId] : []), ...statusDefRows.map((r) => r.id)];
    const extraRows =
      extraDefIds.length > 0
        ? await db
            .select({
              entityId: attributeValues.entityId,
              attributeDefId: attributeValues.attributeDefId,
              valueJson: attributeValues.valueJson,
            })
            .from(attributeValues)
            .where(and(inArray(attributeValues.attributeDefId, extraDefIds), inArray(attributeValues.entityId, entityIds), isNull(attributeValues.deletedAt)))
            .limit(50_000)
        : [];
    const contractIdByEntity: Record<string, string | null> = {};
    const statusFlagsByEntity: Record<string, Partial<Record<StatusCode, boolean>>> = {};
    for (const row of extraRows) {
      if (row.attributeDefId === contractIdDefId) {
        const v = row.valueJson ? safeJsonParse(row.valueJson) : null;
        contractIdByEntity[row.entityId] = typeof v === 'string' && v ? v : null;
      } else {
        const code = statusDefById.get(row.attributeDefId);
        if (code) {
          const ent = statusFlagsByEntity[row.entityId];
          const obj = ent ?? {};
          obj[code as StatusCode] = Boolean(row.valueJson ? safeJsonParse(row.valueJson) : null);
          statusFlagsByEntity[row.entityId] = obj;
        }
      }
    }

    const attrsByEntity: Record<string, { name?: string; article?: string; assemblyUnitNumber?: string; engineBrandQtyMap?: Record<string, number> }> = {};
    for (const attr of attrRows) {
      if (!attrsByEntity[attr.entityId]) attrsByEntity[attr.entityId] = {};
      const val = attr.valueJson ? safeJsonParse(attr.valueJson) : null;
      const entityAttrs = attrsByEntity[attr.entityId];
      if (entityAttrs) {
        if (attr.attributeDefId === nameAttrId && typeof val === 'string') {
          entityAttrs.name = val;
        } else if (attr.attributeDefId === articleAttrId && typeof val === 'string') {
          entityAttrs.article = val;
        } else if (attr.attributeDefId === assemblyAttrId && typeof val === 'string') {
          entityAttrs.assemblyUnitNumber = val;
        } else if (attr.attributeDefId === brandQtyMapAttrId && val && typeof val === 'object' && !Array.isArray(val)) {
          const nextMap: Record<string, number> = {};
          for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) continue;
            nextMap[String(k)] = n;
          }
          entityAttrs.engineBrandQtyMap = nextMap;
        }
      }
    }

    const brandsByEntity: Record<string, string[]> = {};
    for (const row of brandRows) {
      const val = row.valueJson ? safeJsonParse(row.valueJson) : null;
      if (Array.isArray(val)) {
        brandsByEntity[row.entityId] = val.filter((x): x is string => typeof x === 'string');
      }
    }

    // Фильтрация по поисковому запросу
    let filtered = entityRows;
    if (qNorm) {
      filtered = entityRows.filter((e) => {
        const attrs = attrsByEntity[e.id] || {};
        const name = normalizeSearch(attrs.name || '');
        const article = normalizeSearch(attrs.article || '');
        return name.includes(qNorm) || article.includes(qNorm);
      });
    }
    if (engineBrandId) {
      filtered = filtered.filter((e) => (brandsByEntity[e.id] ?? []).includes(engineBrandId));
    }

    const parts = filtered.map((e) => {
      const attrs = attrsByEntity[e.id];
      const contractId = contractIdByEntity[e.id];
      const statusFlags = statusFlagsByEntity[e.id];
      return {
        id: e.id,
        ...(attrs?.name && { name: attrs.name }),
        ...(attrs?.article && { article: attrs.article }),
        ...(attrs?.assemblyUnitNumber && { assemblyUnitNumber: attrs.assemblyUnitNumber }),
        ...(attrs?.engineBrandQtyMap && { engineBrandQtyMap: attrs.engineBrandQtyMap }),
        ...(engineBrandId &&
          attrs?.engineBrandQtyMap &&
          attrs.engineBrandQtyMap[engineBrandId] != null && { engineBrandQty: attrs.engineBrandQtyMap[engineBrandId] }),
        createdAt: Number(e.createdAt),
        updatedAt: Number(e.updatedAt),
        ...(contractId != null && { contractId }),
        ...(statusFlags && Object.keys(statusFlags).length > 0 && { statusFlags }),
      };
    });

    return { ok: true, parts };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getPart(args: { partId: string }): Promise<
  | {
      ok: true;
      part: {
        id: string;
        createdAt: number;
        updatedAt: number;
        attributes: Array<{
          id: string;
          code: string;
          name: string;
          dataType: string;
          value: unknown;
          isRequired: boolean;
          sortOrder: number;
          metaJson?: unknown;
        }>;
      };
    }
  | { ok: false; error: string }
> {
  try {
    const typeId = await ensurePartEntityType();
    const partId = String(args.partId || '');

    const entityRows = await db
      .select({ id: entities.id, createdAt: entities.createdAt, updatedAt: entities.updatedAt })
      .from(entities)
      .where(and(eq(entities.id, partId), eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .limit(1);

    if (!entityRows.length) {
      return { ok: false, error: 'part not found' };
    }

    const entity = entityRows[0];
    if (!entity) {
      return { ok: false, error: 'part not found' };
    }

    // Получаем все атрибуты типа Part
    const attrDefs = await db
      .select()
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)))
      .orderBy(attributeDefs.sortOrder, attributeDefs.code);

    // Получаем значения атрибутов для этой детали
    const attrDefIds = attrDefs.map((ad) => ad.id);
    const attrValues = attrDefIds.length
      ? await db
          .select()
          .from(attributeValues)
          .where(
            and(
              eq(attributeValues.entityId, partId),
              isNull(attributeValues.deletedAt),
            ),
          )
          .limit(10_000)
      : [];

    const valuesByDefId: Record<string, unknown> = {};
    for (const av of attrValues) {
      const val = av.valueJson ? safeJsonParse(String(av.valueJson)) : null;
      valuesByDefId[av.attributeDefId] = val;
    }

    const attributes = attrDefs.map((ad) => ({
      id: ad.id,
      code: ad.code,
      name: ad.name,
      dataType: ad.dataType,
      value: valuesByDefId[ad.id] ?? null,
      isRequired: ad.isRequired,
      sortOrder: ad.sortOrder,
      metaJson: ad.metaJson ? safeJsonParse(String(ad.metaJson)) : undefined,
    }));

    return {
      ok: true,
      part: {
        id: entity.id,
        createdAt: Number(entity.createdAt),
        updatedAt: Number(entity.updatedAt),
        attributes,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createPart(args: { actor: AuthUser; attributes?: Record<string, unknown> }): Promise<
  | {
      ok: true;
      part: { id: string; createdAt: number; updatedAt: number };
    }
  | { ok: false; error: string }
> {
  try {
    const typeId = await ensurePartEntityType();
    const attrDefs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)));

    const duplicateId = await findPartDuplicateId(args.attributes ? { typeId, attrDefs, attributes: args.attributes } : { typeId, attrDefs });
    if (duplicateId) {
      return { ok: false, error: `duplicate part exists: ${duplicateId}` };
    }

    const id = randomUUID();
    const ts = nowMs();

    await db.insert(entities).values({
      id,
      typeId,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    await recordSyncChanges(syncActor(args.actor), [
      {
        tableName: SyncTableName.Entities,
        rowId: id,
        op: 'upsert',
        payload: entityPayload({
          id,
          typeId,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        }),
        ts,
      },
    ]);

    // Устанавливаем начальные атрибуты если переданы
    if (args.attributes) {
      const attrDefsFull = await db
        .select()
        .from(attributeDefs)
        .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)));
      for (const [code, value] of Object.entries(args.attributes)) {
        const def = attrDefsFull.find((ad) => ad.code === code);
        if (!def) continue;
        const existing = await db
          .select({ id: attributeValues.id, createdAt: attributeValues.createdAt })
          .from(attributeValues)
          .where(and(eq(attributeValues.entityId, id), eq(attributeValues.attributeDefId, def.id), isNull(attributeValues.deletedAt)))
          .limit(1);
        const rowId = existing[0]?.id ? String(existing[0].id) : randomUUID();
        const createdAt = existing[0]?.createdAt ? Number(existing[0].createdAt) : ts;

        await db
          .insert(attributeValues)
          .values({
            id: rowId,
            entityId: id,
            attributeDefId: def.id,
            valueJson: toValueJson(value),
            createdAt,
            updatedAt: ts,
            deletedAt: null,
            syncStatus: 'pending',
          })
          .onConflictDoUpdate({
            target: [attributeValues.entityId, attributeValues.attributeDefId],
            set: {
              valueJson: toValueJson(value),
              updatedAt: ts,
              syncStatus: 'pending',
            },
          });
        await recordSyncChanges(syncActor(args.actor), [
          {
            tableName: SyncTableName.AttributeValues,
            rowId,
            op: 'upsert',
            payload: attributeValuePayload({
              id: rowId,
              entityId: id,
              attributeDefId: String(def.id),
              valueJson: toValueJson(value),
              createdAt,
              updatedAt: ts,
              deletedAt: null,
              syncStatus: 'pending',
            }),
            ts,
          },
        ]);
      }
    }

    const auditId = randomUUID();
    await db.insert(auditLog).values({
      id: auditId,
      actor: args.actor.username,
      action: 'part.create',
      entityId: id,
      tableName: 'entities',
      payloadJson: JSON.stringify({ partId: id, attributes: args.attributes }),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    await recordSyncChanges(syncActor(args.actor), [
      {
        tableName: SyncTableName.AuditLog,
        rowId: auditId,
        op: 'upsert',
        payload: auditLogPayload({
          id: auditId,
          actor: args.actor.username,
          action: 'part.create',
          entityId: id,
          tableName: 'entities',
          payloadJson: JSON.stringify({ partId: id, attributes: args.attributes }),
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        }),
        ts,
      },
    ]);

    await db
      .insert(rowOwners)
      .values({
        id: randomUUID(),
        tableName: SyncTableName.Entities,
        rowId: id,
        ownerUserId: args.actor.id,
        ownerUsername: args.actor.username,
        createdAt: ts,
      })
      .onConflictDoNothing();

    return { ok: true, part: { id, createdAt: ts, updatedAt: ts } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function updatePartAttribute(args: {
  partId: string;
  attributeCode: string;
  value: unknown;
  actor: AuthUser;
}): Promise<{ ok: true; queued?: boolean; changeRequestId?: string } | { ok: false; error: string }> {
  try {
    const typeId = await ensurePartEntityType();
    const partId = String(args.partId || '');
    const attrCode = String(args.attributeCode || '');

    // Проверяем существование детали
    const entityRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, partId), eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .limit(1);
    if (!entityRows.length) return { ok: false, error: 'part not found' };

    // Находим определение атрибута
    const attrDefRows = await db
      .select()
      .from(attributeDefs)
      .where(
        and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, attrCode), isNull(attributeDefs.deletedAt)),
      )
      .limit(1);
    if (!attrDefRows.length) return { ok: false, error: 'attribute not found' };

    const attrDef = attrDefRows[0];
    if (!attrDef) return { ok: false, error: 'attribute not found' };
    const ts = nowMs();

    const attrDefs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)));

    const duplicateId = await findPartDuplicateOnUpdate({
      partId,
      typeId,
      attrDefs,
      nextDefId: String(attrDef.id),
      nextValueJson: toValueJson(args.value),
    });
    if (duplicateId) {
      return { ok: false, error: `duplicate part exists: ${duplicateId}` };
    }

    const actorRole = String(args.actor.role || '').toLowerCase();
    const actorIsAdmin = actorRole === 'admin' || actorRole === 'superadmin';
    const owner = await db
      .select({ ownerUserId: rowOwners.ownerUserId, ownerUsername: rowOwners.ownerUsername })
      .from(rowOwners)
      .where(and(eq(rowOwners.tableName, SyncTableName.Entities), eq(rowOwners.rowId, partId as any)))
      .limit(1);
    const ownerUserId = owner[0]?.ownerUserId ? String(owner[0].ownerUserId) : null;
    const ownerUsername = owner[0]?.ownerUsername ? String(owner[0].ownerUsername) : null;

    // Обновляем или создаем значение атрибута
    const existing = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.entityId, partId), eq(attributeValues.attributeDefId, attrDef.id), isNull(attributeValues.deletedAt)))
      .limit(1);
    const existingRow = existing[0] as any;
    const existingId = existingRow?.id ? String(existingRow.id) : null;

    if (!actorIsAdmin && (!ownerUserId || ownerUserId !== args.actor.id)) {
      const rowId = existingId ?? randomUUID();
      const before = existingRow
        ? {
            id: String(existingRow.id),
            entity_id: String(existingRow.entityId),
            attribute_def_id: String(existingRow.attributeDefId),
            value_json: existingRow.valueJson == null ? null : String(existingRow.valueJson),
            created_at: Number(existingRow.createdAt),
            updated_at: Number(existingRow.updatedAt),
            deleted_at: existingRow.deletedAt == null ? null : Number(existingRow.deletedAt),
            sync_status: String(existingRow.syncStatus ?? 'synced'),
          }
        : null;
      const after = {
        id: rowId,
        entity_id: partId,
        attribute_def_id: String(attrDef.id),
        value_json: JSON.stringify(args.value),
        created_at: existingRow ? Number(existingRow.createdAt) : ts,
        updated_at: ts,
        deleted_at: null,
        sync_status: 'pending',
      };

      const changeRequestId = randomUUID();
      await db.insert(changeRequests).values({
        id: changeRequestId,
        status: 'pending',
        tableName: SyncTableName.AttributeValues,
        rowId: rowId as any,
        rootEntityId: partId as any,
        beforeJson: before ? JSON.stringify(before) : null,
        afterJson: JSON.stringify(after),
        recordOwnerUserId: ownerUserId ? (ownerUserId as any) : null,
        recordOwnerUsername: ownerUsername ?? null,
        changeAuthorUserId: args.actor.id as any,
        changeAuthorUsername: args.actor.username,
        note: `part.update_attribute:${attrCode}`,
        createdAt: ts,
        decidedAt: null,
        decidedByUserId: null,
        decidedByUsername: null,
      });

      // Не применяем изменение (pre-approval).
      return { ok: true, queued: true, changeRequestId };
    }

    const attrRowId = existingId ?? randomUUID();
    await db
      .insert(attributeValues)
      .values({
        id: attrRowId,
        entityId: partId,
        attributeDefId: attrDef.id,
        valueJson: JSON.stringify(args.value),
        createdAt: existingRow ? Number(existingRow.createdAt) : ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      })
      .onConflictDoUpdate({
        target: [attributeValues.entityId, attributeValues.attributeDefId],
        set: {
          valueJson: JSON.stringify(args.value),
          updatedAt: ts,
          syncStatus: 'pending',
        },
      });
    await recordSyncChanges(syncActor(args.actor), [
      {
        tableName: SyncTableName.AttributeValues,
        rowId: attrRowId,
        op: 'upsert',
        payload: attributeValuePayload({
          id: attrRowId,
          entityId: partId,
          attributeDefId: String(attrDef.id),
          valueJson: JSON.stringify(args.value),
          createdAt: existingRow ? Number(existingRow.createdAt) : ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        }),
        ts,
      },
    ]);

    // Обновляем updatedAt у сущности
    await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, partId));
    const entityRow = await db.select().from(entities).where(eq(entities.id, partId)).limit(1);
    if (entityRow[0]) {
      await recordSyncChanges(syncActor(args.actor), [
        {
          tableName: SyncTableName.Entities,
          rowId: partId,
          op: 'upsert',
          payload: entityPayload({
            id: String(entityRow[0].id),
            typeId: String(entityRow[0].typeId),
            createdAt: Number(entityRow[0].createdAt),
            updatedAt: ts,
            deletedAt: entityRow[0].deletedAt == null ? null : Number(entityRow[0].deletedAt),
            syncStatus: 'pending',
          }),
          ts,
        },
      ]);
    }

    const auditId = randomUUID();
    await db.insert(auditLog).values({
      id: auditId,
      actor: args.actor.username,
      action: 'part.update_attribute',
      entityId: partId,
      tableName: 'attribute_values',
      payloadJson: JSON.stringify({ partId, attributeCode: attrCode, value: args.value }),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    await recordSyncChanges(syncActor(args.actor), [
      {
        tableName: SyncTableName.AuditLog,
        rowId: auditId,
        op: 'upsert',
        payload: auditLogPayload({
          id: auditId,
          actor: args.actor.username,
          action: 'part.update_attribute',
          entityId: partId,
          tableName: 'attribute_values',
          payloadJson: JSON.stringify({ partId, attributeCode: attrCode, value: args.value }),
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        }),
        ts,
      },
    ]);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePart(args: { partId: string; actor: AuthUser }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await ensurePartEntityType();
    const partId = String(args.partId || '');
    const ts = nowMs();

    const actorRole = String(args.actor.role || '').toLowerCase();
    const actorIsAdmin = actorRole === 'admin' || actorRole === 'superadmin';
    const owner = await db
      .select({ ownerUserId: rowOwners.ownerUserId, ownerUsername: rowOwners.ownerUsername })
      .from(rowOwners)
      .where(and(eq(rowOwners.tableName, SyncTableName.Entities), eq(rowOwners.rowId, partId as any)))
      .limit(1);
    const ownerUserId = owner[0]?.ownerUserId ? String(owner[0].ownerUserId) : null;
    const ownerUsername = owner[0]?.ownerUsername ? String(owner[0].ownerUsername) : null;

    if (!actorIsAdmin && (!ownerUserId || ownerUserId !== args.actor.id)) {
      const cur = await db.select().from(entities).where(eq(entities.id, partId)).limit(1);
      const e = cur[0] as any;
      const before = e
        ? {
            id: String(e.id),
            type_id: String(e.typeId),
            created_at: Number(e.createdAt),
            updated_at: Number(e.updatedAt),
            deleted_at: e.deletedAt == null ? null : Number(e.deletedAt),
            sync_status: String(e.syncStatus ?? 'synced'),
          }
        : null;
      const after = before
        ? { ...before, deleted_at: ts, updated_at: ts, sync_status: 'pending' }
        : {
            id: partId,
            type_id: '', // unknown; best-effort
            created_at: ts,
            updated_at: ts,
            deleted_at: ts,
            sync_status: 'pending',
          };

      await db.insert(changeRequests).values({
        id: randomUUID(),
        status: 'pending',
        tableName: SyncTableName.Entities,
        rowId: partId as any,
        rootEntityId: partId as any,
        beforeJson: before ? JSON.stringify(before) : null,
        afterJson: JSON.stringify(after),
        recordOwnerUserId: ownerUserId ? (ownerUserId as any) : null,
        recordOwnerUsername: ownerUsername ?? null,
        changeAuthorUserId: args.actor.id as any,
        changeAuthorUsername: args.actor.username,
        note: 'part.delete',
        createdAt: ts,
        decidedAt: null,
        decidedByUserId: null,
        decidedByUsername: null,
      });

      return { ok: true };
    }

    const entityRow = await db.select().from(entities).where(eq(entities.id, partId)).limit(1);
    const valueRows = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.entityId, partId), isNull(attributeValues.deletedAt)))
      .limit(50_000);

    // Мягкое удаление: помечаем deleted_at
    await db.update(entities).set({ deletedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, partId));
    await db
      .update(attributeValues)
      .set({ deletedAt: ts, syncStatus: 'pending' })
      .where(eq(attributeValues.entityId, partId));

    if (entityRow[0]) {
      await recordSyncChanges(syncActor(args.actor), [
        {
          tableName: SyncTableName.Entities,
          rowId: partId,
          op: 'delete',
          payload: entityPayload({
            id: String(entityRow[0].id),
            typeId: String(entityRow[0].typeId),
            createdAt: Number(entityRow[0].createdAt),
            updatedAt: ts,
            deletedAt: ts,
            syncStatus: 'pending',
          }),
          ts,
        },
      ]);
    }

    if (valueRows.length > 0) {
      await recordSyncChanges(
        syncActor(args.actor),
        valueRows.map((row: any) => ({
          tableName: SyncTableName.AttributeValues,
          rowId: String(row.id),
          op: 'delete' as const,
          payload: attributeValuePayload({
            id: String(row.id),
            entityId: String(row.entityId),
            attributeDefId: String(row.attributeDefId),
            valueJson: row.valueJson == null ? null : String(row.valueJson),
            createdAt: Number(row.createdAt),
            updatedAt: ts,
            deletedAt: ts,
            syncStatus: 'pending',
          }),
          ts,
        })),
      );
    }

    const auditId = randomUUID();
    await db.insert(auditLog).values({
      id: auditId,
      actor: args.actor.username,
      action: 'part.delete',
      entityId: partId,
      tableName: 'entities',
      payloadJson: JSON.stringify({ partId }),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    await recordSyncChanges(syncActor(args.actor), [
      {
        tableName: SyncTableName.AuditLog,
        rowId: auditId,
        op: 'upsert',
        payload: auditLogPayload({
          id: auditId,
          actor: args.actor.username,
          action: 'part.delete',
          entityId: partId,
          tableName: 'entities',
          payloadJson: JSON.stringify({ partId }),
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        }),
        ts,
      },
    ]);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

