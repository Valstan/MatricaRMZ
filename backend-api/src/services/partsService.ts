import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import {
  AttributeDataType,
  EntityTypeCode,
  PART_DIMENSIONS_ATTR_CODE,
  PART_TEMPLATE_ID_ATTR_CODE,
  SyncTableName,
  STATUS_CODES,
  type PartDimension,
  type StatusCode,
} from '@matricarmz/shared';

type PartEngineBrandLink = {
  id: string;
  partId: string;
  engineBrandId: string;
  assemblyUnitNumber: string;
  quantity: number;
};

const PART_ENGINE_BRAND_ENTITY_TYPE_CODE = (EntityTypeCode as { PartEngineBrand?: string }).PartEngineBrand || 'part_engine_brand';
const PART_TEMPLATE_ENTITY_TYPE_CODE = (EntityTypeCode as { PartTemplate?: string }).PartTemplate || 'part_template';

import { db } from '../database/db.js';
import { changeRequests, rowOwners, attributeDefs, attributeValues, auditLog, entities, entityTypes } from '../database/schema.js';
import type { AuthUser } from '../auth/jwt.js';
import { recordSyncChanges } from './sync/syncChangeService.js';
import { refreshPartWarehouseNomenclatureLinks } from './warehouseService.js';

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

function valueToSearchText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => valueToSearchText(item)).join(' ');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => valueToSearchText(item))
      .join(' ');
  }
  return '';
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
  await ensure(PART_TEMPLATE_ID_ATTR_CODE, 'Шаблон детали', AttributeDataType.Link, 15, JSON.stringify({ linkTargetTypeCode: PART_TEMPLATE_ENTITY_TYPE_CODE }));
  await ensure('article', 'Сборочный номер / артикул', AttributeDataType.Text, 20);
  await ensure(PART_DIMENSIONS_ATTR_CODE, 'Размеры', AttributeDataType.Json, 25);
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

async function getPartTemplateEntityTypeId(): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(eq(entityTypes.code, PART_TEMPLATE_ENTITY_TYPE_CODE))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function ensurePartTemplateAttributeDefs(templateTypeId: string): Promise<void> {
  const existing = await db
    .select({ code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, templateTypeId), isNull(attributeDefs.deletedAt)))
    .limit(10_000);
  const have = new Set(existing.map((row) => String(row.code)));
  const ts = nowMs();

  async function ensure(code: string, name: string, dataType: string, sortOrder: number, metaJson?: string | null) {
    if (have.has(code)) return;
    const id = randomUUID();
    await db.insert(attributeDefs).values({
      id,
      entityTypeId: templateTypeId,
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
          entityTypeId: templateTypeId,
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

  await ensure('name', 'Название шаблона', AttributeDataType.Text, 10);
  await ensure('description', 'Описание', AttributeDataType.Text, 20);
}

async function ensurePartTemplateEntityType(): Promise<string> {
  const existing = await getPartTemplateEntityTypeId();
  if (existing) {
    await ensurePartTemplateAttributeDefs(existing);
    return existing;
  }

  const id = randomUUID();
  const ts = nowMs();
  await db.insert(entityTypes).values({
    id,
    code: PART_TEMPLATE_ENTITY_TYPE_CODE,
    name: 'Шаблон детали',
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
        code: PART_TEMPLATE_ENTITY_TYPE_CODE,
        name: 'Шаблон детали',
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      }),
      ts,
    },
  ]);
  await ensurePartTemplateAttributeDefs(id);
  return id;
}

async function getAttributeDefsForEntityType(entityTypeId: string) {
  return db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId), isNull(attributeDefs.deletedAt)))
    .orderBy(attributeDefs.sortOrder, attributeDefs.code);
}

async function upsertAttributeValueDirect(args: {
  entityId: string;
  attributeDefId: string;
  value: unknown;
  actor?: AuthUser | null;
  ts?: number;
}) {
  const ts = Number(args.ts ?? nowMs());
  const existing = await db
    .select({ id: attributeValues.id, createdAt: attributeValues.createdAt })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, args.entityId), eq(attributeValues.attributeDefId, args.attributeDefId), isNull(attributeValues.deletedAt)))
    .limit(1);
  const rowId = existing[0]?.id ? String(existing[0].id) : randomUUID();
  const createdAt = existing[0]?.createdAt ? Number(existing[0].createdAt) : ts;
  const valueJson = toValueJson(args.value);
  await db
    .insert(attributeValues)
    .values({
      id: rowId,
      entityId: args.entityId,
      attributeDefId: args.attributeDefId,
      valueJson,
      createdAt,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    })
    .onConflictDoUpdate({
      target: [attributeValues.entityId, attributeValues.attributeDefId],
      set: {
        valueJson,
        updatedAt: ts,
        syncStatus: 'pending',
      },
    });
  await recordSyncChanges(syncActor(args.actor ?? undefined), [
    {
      tableName: SyncTableName.AttributeValues,
      rowId,
      op: 'upsert',
      payload: attributeValuePayload({
        id: rowId,
        entityId: args.entityId,
        attributeDefId: args.attributeDefId,
        valueJson,
        createdAt,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      }),
      ts,
    },
  ]);
  return { rowId, createdAt };
}

async function touchEntityUpdatedAt(args: { entityId: string; typeId: string; actor?: AuthUser | null; ts?: number; deletedAt?: number | null }) {
  const ts = Number(args.ts ?? nowMs());
  const current = await db
    .select({ id: entities.id, createdAt: entities.createdAt })
    .from(entities)
    .where(eq(entities.id, args.entityId))
    .limit(1);
  const createdAt = Number(current[0]?.createdAt ?? ts);
  await db
    .update(entities)
    .set({ updatedAt: ts, deletedAt: args.deletedAt ?? null, syncStatus: 'pending' })
    .where(eq(entities.id, args.entityId));
  await recordSyncChanges(syncActor(args.actor ?? undefined), [
    {
      tableName: SyncTableName.Entities,
      rowId: args.entityId,
      op: 'upsert',
      payload: entityPayload({
        id: args.entityId,
        typeId: args.typeId,
        createdAt,
        updatedAt: ts,
        deletedAt: args.deletedAt ?? null,
        syncStatus: 'pending',
      }),
      ts,
    },
  ]);
}

async function insertEntityDirect(args: { entityId?: string; typeId: string; actor?: AuthUser | null; ts?: number }) {
  const entityId = String(args.entityId || randomUUID());
  const ts = Number(args.ts ?? nowMs());
  await db.insert(entities).values({
    id: entityId,
    typeId: args.typeId,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
  await recordSyncChanges(syncActor(args.actor ?? undefined), [
    {
      tableName: SyncTableName.Entities,
      rowId: entityId,
      op: 'upsert',
      payload: entityPayload({
        id: entityId,
        typeId: args.typeId,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      }),
      ts,
    },
  ]);
  if (args.actor) {
    await db
      .insert(rowOwners)
      .values({
        id: randomUUID(),
        tableName: SyncTableName.Entities,
        rowId: entityId,
        ownerUserId: args.actor.id,
        ownerUsername: args.actor.username,
        createdAt: ts,
      })
      .onConflictDoNothing();
  }
  return { entityId, ts };
}

async function findPartTemplateDuplicateId(args: { templateTypeId: string; name: string; excludeTemplateId?: string | null }): Promise<string | null> {
  const normalizedName = normalizeSearch(args.name);
  if (!normalizedName) return null;
  const attrDefsRows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, args.templateTypeId), isNull(attributeDefs.deletedAt)))
    .limit(10_000);
  const nameDef = attrDefsRows.find((row) => String(row.code) === 'name');
  if (!nameDef) return null;
  const rows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(attributeValues.attributeDefId, nameDef.id),
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        eq(entities.typeId, args.templateTypeId),
      ),
    )
    .limit(50_000);
  for (const row of rows) {
    const entityId = String(row.entityId);
    if (args.excludeTemplateId && entityId === String(args.excludeTemplateId)) continue;
    const name = typeof safeJsonParse(String(row.valueJson ?? 'null')) === 'string' ? String(safeJsonParse(String(row.valueJson ?? 'null'))) : '';
    if (normalizeSearch(name) === normalizedName) return entityId;
  }
  return null;
}

async function createPartTemplateEntity(args: { actor?: AuthUser | null; attributes?: Record<string, unknown> }) {
  const templateTypeId = await ensurePartTemplateEntityType();
  const attrDefsRows = await getAttributeDefsForEntityType(templateTypeId);
  const attrDefByCode = new Map(attrDefsRows.map((row) => [String(row.code), String(row.id)] as const));
  const ts = nowMs();
  const entityId = randomUUID();
  await insertEntityDirect({ entityId, typeId: templateTypeId, actor: args.actor ?? null, ts });
  for (const [code, value] of Object.entries(args.attributes ?? {})) {
    const defId = attrDefByCode.get(code);
    if (!defId) continue;
    await upsertAttributeValueDirect({ entityId, attributeDefId: defId, value, actor: args.actor ?? null, ts });
  }
  return { templateTypeId, entityId, ts };
}

let partTemplateBackfillPromise: Promise<void> | null = null;

async function ensureExistingPartTemplateAssignments() {
  if (partTemplateBackfillPromise) {
    await partTemplateBackfillPromise;
    return;
  }
  partTemplateBackfillPromise = (async () => {
    const partTypeId = await ensurePartEntityType();
    const templateTypeId = await ensurePartTemplateEntityType();
    const partAttrDefs = await getAttributeDefsForEntityType(partTypeId);
    const templateAttrDefs = await getAttributeDefsForEntityType(templateTypeId);
    const partDefByCode = new Map(partAttrDefs.map((row) => [String(row.code), row] as const));
    const templateDefByCode = new Map(templateAttrDefs.map((row) => [String(row.code), row] as const));
    const partNameDef = partDefByCode.get('name');
    const partDescriptionDef = partDefByCode.get('description');
    const partTemplateDef = partDefByCode.get(PART_TEMPLATE_ID_ATTR_CODE);
    const templateNameDef = templateDefByCode.get('name');
    const templateDescriptionDef = templateDefByCode.get('description');
    if (!partNameDef || !partTemplateDef || !templateNameDef) return;

    const partRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.typeId, partTypeId), isNull(entities.deletedAt)))
      .limit(100_000);
    const templateRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.typeId, templateTypeId), isNull(entities.deletedAt)))
      .limit(100_000);
    const partIds = partRows.map((row) => String(row.id));
    const templateIds = templateRows.map((row) => String(row.id));
    const partAttrIds = [partNameDef.id, partTemplateDef.id, ...(partDescriptionDef ? [partDescriptionDef.id] : [])];
    const templateAttrIds = [templateNameDef.id, ...(templateDescriptionDef ? [templateDescriptionDef.id] : [])];
    const partValues = partIds.length
      ? await db
          .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, partIds as any), inArray(attributeValues.attributeDefId, partAttrIds as any), isNull(attributeValues.deletedAt)))
          .limit(200_000)
      : [];
    const templateValues = templateIds.length
      ? await db
          .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, templateIds as any), inArray(attributeValues.attributeDefId, templateAttrIds as any), isNull(attributeValues.deletedAt)))
          .limit(200_000)
      : [];

    const partState = new Map<string, { name: string; description: string; templateId: string }>();
    for (const row of partValues) {
      const entityId = String(row.entityId);
      const entry = partState.get(entityId) ?? { name: '', description: '', templateId: '' };
      const parsed = safeJsonParse(String(row.valueJson ?? 'null'));
      if (String(row.attributeDefId) === String(partNameDef.id)) entry.name = typeof parsed === 'string' ? parsed : '';
      if (partDescriptionDef && String(row.attributeDefId) === String(partDescriptionDef.id)) entry.description = typeof parsed === 'string' ? parsed : '';
      if (String(row.attributeDefId) === String(partTemplateDef.id)) entry.templateId = typeof parsed === 'string' ? parsed : '';
      partState.set(entityId, entry);
    }

    const templateNameMap = new Map<string, { id: string; name: string; description: string }>();
    const templateState = new Map<string, { name: string; description: string }>();
    for (const row of templateValues) {
      const entityId = String(row.entityId);
      const entry = templateState.get(entityId) ?? { name: '', description: '' };
      const parsed = safeJsonParse(String(row.valueJson ?? 'null'));
      if (String(row.attributeDefId) === String(templateNameDef.id)) entry.name = typeof parsed === 'string' ? parsed : '';
      if (templateDescriptionDef && String(row.attributeDefId) === String(templateDescriptionDef.id)) {
        entry.description = typeof parsed === 'string' ? parsed : '';
      }
      templateState.set(entityId, entry);
    }
    for (const [entityId, entry] of templateState) {
      const normalizedName = normalizeSearch(entry.name);
      if (!normalizedName) continue;
      if (!templateNameMap.has(normalizedName)) {
        templateNameMap.set(normalizedName, { id: entityId, name: entry.name, description: entry.description });
      }
    }

    for (const partId of partIds) {
      const state = partState.get(partId) ?? { name: '', description: '', templateId: '' };
      const normalizedName = normalizeSearch(state.name);
      if (!normalizedName) continue;
      let template = templateNameMap.get(normalizedName) ?? null;
      if (!template) {
        const created = await createPartTemplateEntity({
          attributes: {
            name: state.name.trim(),
            ...(state.description.trim() ? { description: state.description.trim() } : {}),
          },
        });
        template = { id: created.entityId, name: state.name.trim(), description: state.description.trim() };
        templateNameMap.set(normalizedName, template);
      }
      if (state.templateId !== template.id) {
        await upsertAttributeValueDirect({
          entityId: partId,
          attributeDefId: String(partTemplateDef.id),
          value: template.id,
          ts: nowMs(),
        });
        await touchEntityUpdatedAt({ entityId: partId, typeId: partTypeId, ts: nowMs() });
      }
    }
  })();
  try {
    await partTemplateBackfillPromise;
  } finally {
    partTemplateBackfillPromise = null;
  }
}

async function getPartEngineBrandTypeId(): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(eq(entityTypes.code, PART_ENGINE_BRAND_ENTITY_TYPE_CODE))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function ensurePartEngineBrandAttributeDefs(partEngineBrandTypeId: string): Promise<void> {
  const existing = await db
    .select({ code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, partEngineBrandTypeId), isNull(attributeDefs.deletedAt)))
    .limit(10_000);
  const have = new Set(existing.map((r) => String(r.code)));

  const ts = nowMs();
  async function ensure(code: string, name: string, dataType: string, sortOrder: number, metaJson?: string | null) {
    if (have.has(code)) return;
    const id = randomUUID();
    await db.insert(attributeDefs).values({
      id,
      entityTypeId: partEngineBrandTypeId,
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
          entityTypeId: partEngineBrandTypeId,
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

  await ensure('part_id', 'Деталь', AttributeDataType.Link, 10, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Part }));
  await ensure('engine_brand_id', 'Марка двигателя', AttributeDataType.Link, 20, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.EngineBrand }));
  await ensure('assembly_unit_number', 'Номер сборочной единицы', AttributeDataType.Text, 30);
  await ensure('quantity', 'Количество', AttributeDataType.Number, 40);
}

async function ensurePartEngineBrandEntityType(): Promise<string> {
  const existing = await getPartEngineBrandTypeId();
  if (existing) {
    await ensurePartEngineBrandAttributeDefs(existing);
    return existing;
  }

  const id = randomUUID();
  const ts = nowMs();
  await db.insert(entityTypes).values({
    id,
    code: PART_ENGINE_BRAND_ENTITY_TYPE_CODE,
    name: 'Связь деталь ↔ марка',
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
        code: PART_ENGINE_BRAND_ENTITY_TYPE_CODE,
        name: 'Связь деталь ↔ марка',
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      }),
      ts,
    },
  ]);

  await ensurePartEngineBrandAttributeDefs(id);
  return id;
}

async function findPartDuplicateId(args: {
  typeId: string;
  attrDefs: { id: string; code: string }[];
  attributes?: Record<string, unknown>;
}): Promise<string | null> {
  const articleDef = args.attrDefs.find((d) => String(d.code) === 'article');
  const articleValue = args.attributes?.article;
  const normalizedArticle = normalizeSearch(typeof articleValue === 'string' ? articleValue : articleValue == null ? '' : String(articleValue));
  if (articleDef && normalizedArticle) {
    const rows = await db
      .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
      .from(attributeValues)
      .innerJoin(entities, eq(attributeValues.entityId, entities.id))
      .where(
        and(
          eq(attributeValues.attributeDefId, articleDef.id),
          isNull(attributeValues.deletedAt),
          isNull(entities.deletedAt),
          eq(entities.typeId, args.typeId),
        ),
      )
      .limit(50_000);
    for (const row of rows) {
      const parsed = safeJsonParse(String(row.valueJson ?? 'null'));
      const candidateArticle = typeof parsed === 'string' ? parsed : parsed == null ? '' : String(parsed);
      if (normalizeSearch(candidateArticle) === normalizedArticle) {
        return String(row.entityId);
      }
    }
  }

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
  const articleDef = args.attrDefs.find((d) => String(d.code) === 'article');
  if (articleDef) {
    const relevantValueJson = args.nextDefId === String(articleDef.id) ? args.nextValueJson : null;
    let articleValueJson = relevantValueJson;
    if (articleValueJson == null) {
      const currentArticleRow = await db
        .select({ valueJson: attributeValues.valueJson })
        .from(attributeValues)
        .where(and(eq(attributeValues.entityId, args.partId), eq(attributeValues.attributeDefId, articleDef.id), isNull(attributeValues.deletedAt)))
        .limit(1);
      articleValueJson = currentArticleRow[0]?.valueJson == null ? null : String(currentArticleRow[0].valueJson);
    }
    const articleParsed = safeJsonParse(String(articleValueJson ?? 'null'));
    const normalizedArticle = normalizeSearch(typeof articleParsed === 'string' ? articleParsed : articleParsed == null ? '' : String(articleParsed));
    if (normalizedArticle) {
      const rows = await db
        .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
        .from(attributeValues)
        .innerJoin(entities, eq(attributeValues.entityId, entities.id))
        .where(
          and(
            eq(attributeValues.attributeDefId, articleDef.id),
            isNull(attributeValues.deletedAt),
            isNull(entities.deletedAt),
            eq(entities.typeId, args.typeId),
          ),
        )
        .limit(50_000);
      for (const row of rows) {
        const entityId = String(row.entityId);
        if (entityId === args.partId) continue;
        const parsed = safeJsonParse(String(row.valueJson ?? 'null'));
        const candidateArticle = typeof parsed === 'string' ? parsed : parsed == null ? '' : String(parsed);
        if (normalizeSearch(candidateArticle) === normalizedArticle) {
          return entityId;
        }
      }
    }
  }

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
    await ensureExistingPartTemplateAssignments();
    const typeId = await ensurePartEntityType();
    const ts = nowMs();

    const code = String(args.code ?? '').trim();
    const name = String(args.name ?? '').trim();
    const dataType = String(args.dataType ?? '').trim();
    const sortOrder = Number(args.sortOrder ?? 0) || 0;
    const isRequired = args.isRequired === true;
    const metaJson = args.metaJson == null ? null : String(args.metaJson);

    if (!code) return { ok: false, error: 'код не указан' };
    if (!name) return { ok: false, error: 'название не указано' };
    if (!dataType) return { ok: false, error: 'тип данных не указан' };

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

async function listPartBrandLinksInternal(args?: { partIds?: string[]; partId?: string; engineBrandId?: string }): Promise<PartEngineBrandLink[]> {
  const partBrandTypeId = await ensurePartEngineBrandEntityType();
  const attrDefRows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, partBrandTypeId), isNull(attributeDefs.deletedAt)));
  const attrDefByCode = new Map(attrDefRows.map((r) => [String(r.code), String(r.id)] as [string, string]));
  const partIdAttrId = attrDefByCode.get('part_id');
  const engineBrandIdAttrId = attrDefByCode.get('engine_brand_id');
  const assemblyUnitAttrId = attrDefByCode.get('assembly_unit_number');
  const quantityAttrId = attrDefByCode.get('quantity');
  if (!partIdAttrId || !engineBrandIdAttrId || !assemblyUnitAttrId || !quantityAttrId) return [];

  const entityRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, partBrandTypeId), isNull(entities.deletedAt)))
    .limit(20_000);
  const linkEntityIds = entityRows.map((r) => String(r.id));
  if (linkEntityIds.length === 0) return [];

  const valueRows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, linkEntityIds as any),
        inArray(attributeValues.attributeDefId, [partIdAttrId, engineBrandIdAttrId, assemblyUnitAttrId, quantityAttrId] as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(120_000);

  const parsedByEntity = new Map<
    string,
    {
      partId?: string;
      engineBrandId?: string;
      assemblyUnitNumber?: string;
      quantity?: number;
    }
  >();
  for (const row of valueRows as any[]) {
    const entityId = String(row.entityId);
    const val = row.valueJson ? safeJsonParse(String(row.valueJson)) : null;
    const current = parsedByEntity.get(entityId) ?? {};
    if (row.attributeDefId === partIdAttrId && typeof val === 'string' && val.trim()) {
      current.partId = val.trim();
    } else if (row.attributeDefId === engineBrandIdAttrId && typeof val === 'string' && val.trim()) {
      current.engineBrandId = val.trim();
    } else if (row.attributeDefId === assemblyUnitAttrId && typeof val === 'string') {
      current.assemblyUnitNumber = val.trim();
    } else if (row.attributeDefId === quantityAttrId) {
      const n = typeof val === 'number' ? val : Number(val);
      if (Number.isFinite(n)) {
        current.quantity = n;
      }
    }
    parsedByEntity.set(entityId, current);
  }

  const normalizedPartId = args?.partId ? String(args.partId) : null;
  const normalizedEngineBrandId = args?.engineBrandId ? String(args.engineBrandId) : null;
  const normalizedPartIds = args?.partIds ? new Set(args.partIds.map((id) => String(id))) : null;

  const result: PartEngineBrandLink[] = [];
  for (const row of entityRows) {
    const link = parsedByEntity.get(row.id);
    if (!link?.partId || !link.engineBrandId || !link.assemblyUnitNumber) continue;
    if (normalizedPartId && link.partId !== normalizedPartId) continue;
    if (normalizedEngineBrandId && link.engineBrandId !== normalizedEngineBrandId) continue;
    if (normalizedPartIds && !normalizedPartIds.has(link.partId)) continue;

    result.push({
      id: row.id,
      partId: link.partId,
      engineBrandId: link.engineBrandId,
      assemblyUnitNumber: link.assemblyUnitNumber,
      quantity: Number(link.quantity ?? 0),
    });
  }

  return result;
}

export async function listParts(args?: { q?: string; limit?: number; offset?: number; engineBrandId?: string; templateId?: string }): Promise<
  | {
      ok: true;
      parts: {
        id: string;
        name?: string;
        article?: string;
        templateId?: string;
        templateName?: string;
        dimensions?: PartDimension[];
        contractId?: string;
        statusFlags?: Partial<Record<StatusCode, boolean>>;
        brandLinks?: PartEngineBrandLink[];
        attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
        updatedAt: number;
        createdAt: number;
      }[];
    }
  | { ok: false; error: string }
> {
  try {
    await ensureExistingPartTemplateAssignments();
    const typeId = await ensurePartEntityType();
    const templateTypeId = await ensurePartTemplateEntityType();
    const limit = args?.limit ?? 1000;
    const offset = Math.max(0, Math.trunc(Number(args?.offset ?? 0) || 0));
    const qNorm = args?.q ? normalizeSearch(args.q) : '';
    const engineBrandId = args?.engineBrandId ? String(args.engineBrandId).trim() : '';
    const templateIdFilter = args?.templateId ? String(args.templateId).trim() : '';

    const entityRows = await db
      .select({ id: entities.id, createdAt: entities.createdAt, updatedAt: entities.updatedAt })
      .from(entities)
      .where(and(eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .orderBy(desc(entities.updatedAt))
      .limit(limit)
      .offset(offset);
    if (!entityRows.length) {
      return { ok: true, parts: [] };
    }

    const partIds = entityRows.map((r) => r.id);
    const brandLinks = await listPartBrandLinksInternal({ partIds });
    const brandLinksByPart: Record<string, PartEngineBrandLink[]> = {};
    for (const link of brandLinks) {
      const bucket = brandLinksByPart[link.partId] ?? [];
      bucket.push(link);
      brandLinksByPart[link.partId] = bucket;
    }

    const attrDefRows = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)))
      .limit(10_000);
    const attrDefById = new Map(attrDefRows.map((row) => [row.id, String(row.code)] as const));
    const attrDefIds = attrDefRows.map((row) => row.id);
    const statusCodes = new Set<string>(STATUS_CODES);
    const attrRows =
      attrDefIds.length > 0
        ? await db
            .select({
              entityId: attributeValues.entityId,
              attributeDefId: attributeValues.attributeDefId,
              valueJson: attributeValues.valueJson,
            })
            .from(attributeValues)
            .where(and(inArray(attributeValues.attributeDefId, attrDefIds), inArray(attributeValues.entityId, partIds), isNull(attributeValues.deletedAt)))
            .limit(200_000)
        : [];

    const attrsByEntity: Record<string, { name?: string; article?: string; searchParts: string[] }> = {};
    const contractIdByEntity: Record<string, string | null> = {};
    const templateIdByEntity: Record<string, string | null> = {};
    const dimensionsByEntity: Record<string, PartDimension[]> = {};
    const statusFlagsByEntity: Record<string, Partial<Record<StatusCode, boolean>>> = {};
    const attachmentPreviewsByEntity: Record<string, Array<{ id: string; name: string; mime: string | null }>> = {};
    for (const attr of attrRows) {
      if (!attrsByEntity[attr.entityId]) attrsByEntity[attr.entityId] = { searchParts: [] };
      const val = attr.valueJson ? safeJsonParse(attr.valueJson) : null;
      const code = attrDefById.get(attr.attributeDefId) ?? '';
      const entityAttrs = attrsByEntity[attr.entityId];
      if (entityAttrs) {
        if (code === 'name' && typeof val === 'string') {
          entityAttrs.name = val;
        } else if (code === 'article' && typeof val === 'string') {
          entityAttrs.article = val;
        }
        const valueText = valueToSearchText(val);
        if (valueText) entityAttrs.searchParts.push(valueText);
        if (code === 'contract_id') {
          contractIdByEntity[attr.entityId] = typeof val === 'string' && val ? val : null;
        } else if (code === PART_TEMPLATE_ID_ATTR_CODE) {
          templateIdByEntity[attr.entityId] = typeof val === 'string' && val ? val : null;
        } else if (code === PART_DIMENSIONS_ATTR_CODE) {
          const rows = Array.isArray(val) ? val : [];
          const dimensions = rows
            .filter((row) => row && typeof row === 'object')
            .map((row, index) => {
              const entry = row as Record<string, unknown>;
              const name = typeof entry.name === 'string' ? entry.name.trim() : '';
              const value = typeof entry.value === 'string' ? entry.value.trim() : '';
              if (!name && !value) return null;
              const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `dim-${index + 1}`;
              return { id, name, value } satisfies PartDimension;
            })
            .filter((row): row is PartDimension => Boolean(row));
          dimensionsByEntity[attr.entityId] = dimensions;
        } else if (statusCodes.has(code)) {
          const statusEntry = statusFlagsByEntity[attr.entityId] ?? {};
          statusEntry[code as StatusCode] = Boolean(val);
          statusFlagsByEntity[attr.entityId] = statusEntry;
        } else if (code === 'attachments' || code === 'drawings' || code === 'tech_docs') {
          const bucket = attachmentPreviewsByEntity[attr.entityId] ?? [];
          const seen = new Set(bucket.map((x) => x.id));
          for (const preview of toAttachmentPreviews(val)) {
            if (seen.has(preview.id)) continue;
            seen.add(preview.id);
            bucket.push(preview);
            if (bucket.length >= 5) break;
          }
          attachmentPreviewsByEntity[attr.entityId] = bucket;
        }
      }
    }

    let filtered = entityRows;
    if (qNorm) {
      filtered = filtered.filter((e) => {
        const attrs = attrsByEntity[e.id];
        const statusFlags = statusFlagsByEntity[e.id] ?? {};
        const enabledStatuses = Object.entries(statusFlags)
          .filter(([, enabled]) => enabled === true)
          .map(([code]) => code)
          .join(' ');
        const dimensions = dimensionsByEntity[e.id] ?? [];
        const links = brandLinksByPart[e.id] ?? [];
        const linksText = links.map((link) => `${link.engineBrandId} ${link.assemblyUnitNumber} ${link.quantity}`).join(' ');
        const hay = normalizeSearch(
          [
            e.id,
            attrs?.searchParts.join(' ') ?? '',
            contractIdByEntity[e.id] ?? '',
            templateIdByEntity[e.id] ?? '',
            dimensions.map((row) => `${row.name} ${row.value}`).join(' '),
            enabledStatuses,
            linksText,
          ].join(' '),
        );
        return hay.includes(qNorm);
      });
    }
    if (engineBrandId) {
      filtered = filtered.filter((e) => (brandLinksByPart[e.id] ?? []).some((link) => link.engineBrandId === engineBrandId));
    }
    if (templateIdFilter) {
      filtered = filtered.filter((e) => templateIdByEntity[e.id] === templateIdFilter);
    }

    const templateIds = Array.from(new Set(Object.values(templateIdByEntity).filter((value): value is string => Boolean(value))));
    const templateNameById = new Map<string, string>();
    if (templateIds.length > 0) {
      const templateNameDefRows = await db
        .select({ id: attributeDefs.id })
        .from(attributeDefs)
        .where(and(eq(attributeDefs.entityTypeId, templateTypeId), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
        .limit(1);
      const templateNameDefId = templateNameDefRows[0]?.id ? String(templateNameDefRows[0].id) : '';
      if (templateNameDefId) {
        const templateNameRows = await db
          .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(and(eq(attributeValues.attributeDefId, templateNameDefId), inArray(attributeValues.entityId, templateIds as any), isNull(attributeValues.deletedAt)))
          .limit(50_000);
        for (const row of templateNameRows) {
          const parsed = safeJsonParse(String(row.valueJson ?? 'null'));
          if (typeof parsed === 'string' && parsed.trim()) {
            templateNameById.set(String(row.entityId), parsed.trim());
          }
        }
      }
    }

    const parts = filtered.map((e) => {
      const attrs = attrsByEntity[e.id] ?? { searchParts: [] as string[] };
      const contractId = contractIdByEntity[e.id];
      const templateId = templateIdByEntity[e.id];
      const templateName = templateId ? templateNameById.get(templateId) ?? null : null;
      const dimensions = dimensionsByEntity[e.id] ?? [];
      const statusFlags = statusFlagsByEntity[e.id];
      const attachmentPreviews = attachmentPreviewsByEntity[e.id] ?? [];
      return {
        id: e.id,
        ...(attrs.name && { name: attrs.name }),
        ...(attrs.article && { article: attrs.article }),
        ...(templateId ? { templateId } : {}),
        ...(templateName ? { templateName } : {}),
        ...(dimensions.length > 0 ? { dimensions } : {}),
        ...(contractId != null && { contractId }),
        ...(statusFlags && Object.keys(statusFlags).length > 0 && { statusFlags }),
        ...(brandLinksByPart[e.id]?.length ? { brandLinks: brandLinksByPart[e.id] } : {}),
        ...(attachmentPreviews.length > 0 ? { attachmentPreviews } : {}),
        createdAt: Number(e.createdAt),
        updatedAt: Number(e.updatedAt),
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
        brandLinks?: PartEngineBrandLink[];
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
      return { ok: false, error: 'деталь не найдена' };
    }

    const entity = entityRows[0];
    if (!entity) return { ok: false, error: 'шаблон детали не найден' };
    if (!entity) return { ok: false, error: 'шаблон детали не найден' };
    if (!entity) {
      return { ok: false, error: 'деталь не найдена' };
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
    const brandLinks = await listPartBrandLinksInternal({ partId });

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
        brandLinks,
        attributes,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listPartTemplates(args?: { q?: string; limit?: number; offset?: number }): Promise<
  | {
      ok: true;
      templates: Array<{
        id: string;
        name?: string;
        description?: string;
        updatedAt: number;
        createdAt: number;
      }>;
    }
  | { ok: false; error: string }
> {
  try {
    await ensureExistingPartTemplateAssignments();
    const typeId = await ensurePartTemplateEntityType();
    const limit = args?.limit ?? 1000;
    const offset = Math.max(0, Math.trunc(Number(args?.offset ?? 0) || 0));
    const qNorm = normalizeSearch(args?.q ?? '');
    const rows = await db
      .select({ id: entities.id, createdAt: entities.createdAt, updatedAt: entities.updatedAt })
      .from(entities)
      .where(and(eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .orderBy(desc(entities.updatedAt))
      .limit(limit)
      .offset(offset);
    if (!rows.length) return { ok: true, templates: [] };

    const attrDefsRows = await getAttributeDefsForEntityType(typeId);
    const defByCode = new Map(attrDefsRows.map((row) => [String(row.code), String(row.id)] as const));
    const attrIds = Array.from(defByCode.values());
    const values = attrIds.length
      ? await db
          .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, rows.map((row) => row.id) as any), inArray(attributeValues.attributeDefId, attrIds as any), isNull(attributeValues.deletedAt)))
          .limit(200_000)
      : [];
    const nameDefId = defByCode.get('name') ?? '';
    const descriptionDefId = defByCode.get('description') ?? '';
    const state = new Map<string, { name: string; description: string; search: string[] }>();
    for (const row of values) {
      const entityId = String(row.entityId);
      const entry = state.get(entityId) ?? { name: '', description: '', search: [] };
      const parsed = safeJsonParse(String(row.valueJson ?? 'null'));
      const valueText = valueToSearchText(parsed);
      if (valueText) entry.search.push(valueText);
      if (nameDefId && String(row.attributeDefId) === nameDefId) entry.name = typeof parsed === 'string' ? parsed : '';
      if (descriptionDefId && String(row.attributeDefId) === descriptionDefId) entry.description = typeof parsed === 'string' ? parsed : '';
      state.set(entityId, entry);
    }

    let filtered = rows;
    if (qNorm) {
      filtered = rows.filter((row) => {
        const entry = state.get(String(row.id)) ?? { name: '', description: '', search: [] };
        return normalizeSearch([row.id, entry.name, entry.description, entry.search.join(' ')].join(' ')).includes(qNorm);
      });
    }

    return {
      ok: true,
      templates: filtered.map((row) => {
        const entry = state.get(String(row.id));
        return {
          id: String(row.id),
          ...(entry?.name ? { name: entry.name } : {}),
          ...(entry?.description ? { description: entry.description } : {}),
          createdAt: Number(row.createdAt),
          updatedAt: Number(row.updatedAt),
        };
      }),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getPartTemplate(args: { templateId: string }): Promise<
  | {
      ok: true;
      template: {
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
    await ensureExistingPartTemplateAssignments();
    const typeId = await ensurePartTemplateEntityType();
    const templateId = String(args.templateId || '');
    const entityRows = await db
      .select({ id: entities.id, createdAt: entities.createdAt, updatedAt: entities.updatedAt })
      .from(entities)
      .where(and(eq(entities.id, templateId), eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .limit(1);
    if (!entityRows.length) return { ok: false, error: 'шаблон детали не найден' };

    const entity = entityRows[0];
    if (!entity) return { ok: false, error: 'шаблон детали не найден' };
    const defs = await getAttributeDefsForEntityType(typeId);
    const values = defs.length
      ? await db
          .select()
          .from(attributeValues)
          .where(and(eq(attributeValues.entityId, templateId), isNull(attributeValues.deletedAt)))
          .limit(10_000)
      : [];
    const valueByDefId: Record<string, unknown> = {};
    for (const row of values) {
      valueByDefId[String(row.attributeDefId)] = row.valueJson ? safeJsonParse(String(row.valueJson)) : null;
    }

    return {
      ok: true,
      template: {
        id: String(entity.id),
        createdAt: Number(entity.createdAt),
        updatedAt: Number(entity.updatedAt),
        attributes: defs.map((def) => ({
          id: String(def.id),
          code: String(def.code),
          name: String(def.name),
          dataType: String(def.dataType),
          value: valueByDefId[String(def.id)] ?? null,
          isRequired: Boolean(def.isRequired),
          sortOrder: Number(def.sortOrder ?? 0),
          metaJson: def.metaJson ? safeJsonParse(String(def.metaJson)) : undefined,
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createPartTemplate(args: { actor: AuthUser; attributes?: Record<string, unknown> }): Promise<
  | {
      ok: true;
      template: { id: string; createdAt: number; updatedAt: number };
    }
  | { ok: false; error: string }
> {
  try {
    const name = typeof args.attributes?.name === 'string' ? args.attributes.name.trim() : '';
    const templateTypeId = await ensurePartTemplateEntityType();
    if (name) {
      const duplicateId = await findPartTemplateDuplicateId({ templateTypeId, name });
      if (duplicateId) return { ok: false, error: `duplicate template exists: ${duplicateId}` };
    }
    const created = await createPartTemplateEntity({
      actor: args.actor,
      ...(args.attributes ? { attributes: args.attributes } : {}),
    });
    const auditId = randomUUID();
    await db.insert(auditLog).values({
      id: auditId,
      actor: args.actor.username,
      action: 'partTemplate.create',
      entityId: created.entityId,
      tableName: 'entities',
      payloadJson: JSON.stringify({ templateId: created.entityId, attributes: args.attributes }),
      createdAt: created.ts,
      updatedAt: created.ts,
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
          action: 'partTemplate.create',
          entityId: created.entityId,
          tableName: 'entities',
          payloadJson: JSON.stringify({ templateId: created.entityId, attributes: args.attributes }),
          createdAt: created.ts,
          updatedAt: created.ts,
          deletedAt: null,
          syncStatus: 'pending',
        }),
        ts: created.ts,
      },
    ]);
    return { ok: true, template: { id: created.entityId, createdAt: created.ts, updatedAt: created.ts } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function updatePartTemplateAttribute(args: {
  templateId: string;
  attributeCode: string;
  value: unknown;
  actor: AuthUser;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const typeId = await ensurePartTemplateEntityType();
    const templateId = String(args.templateId || '');
    const attributeCode = String(args.attributeCode || '');
    const entityRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, templateId), eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .limit(1);
    if (!entityRows.length) return { ok: false, error: 'шаблон детали не найден' };
    const defs = await getAttributeDefsForEntityType(typeId);
    const def = defs.find((row) => String(row.code) === attributeCode);
    if (!def) return { ok: false, error: 'атрибут не найден' };
    if (attributeCode === 'name') {
      const nextName = typeof args.value === 'string' ? args.value.trim() : '';
      if (nextName) {
        const duplicateId = await findPartTemplateDuplicateId({ templateTypeId: typeId, name: nextName, excludeTemplateId: templateId });
        if (duplicateId) return { ok: false, error: `duplicate template exists: ${duplicateId}` };
      }
    }
    const ts = nowMs();
    await upsertAttributeValueDirect({ entityId: templateId, attributeDefId: String(def.id), value: args.value, actor: args.actor, ts });
    await touchEntityUpdatedAt({ entityId: templateId, typeId, actor: args.actor, ts });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePartTemplate(args: { templateId: string; actor: AuthUser }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const typeId = await ensurePartTemplateEntityType();
    const templateId = String(args.templateId || '');
    const entityRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, templateId), eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .limit(1);
    if (!entityRows.length) return { ok: false, error: 'шаблон детали не найден' };
    const ts = nowMs();
    await touchEntityUpdatedAt({ entityId: templateId, typeId, actor: args.actor, ts, deletedAt: ts });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createPartFromTemplate(args: {
  templateId: string;
  actor: AuthUser;
  attributes?: Record<string, unknown>;
}): Promise<
  | {
      ok: true;
      part: { id: string; createdAt: number; updatedAt: number };
    }
  | { ok: false; error: string }
> {
  try {
    const template = await getPartTemplate({ templateId: args.templateId });
    if (!template.ok) return { ok: false, error: template.error };
    const attrsByCode = new Map(template.template.attributes.map((row) => [row.code, row.value] as const));
    const name = typeof attrsByCode.get('name') === 'string' ? String(attrsByCode.get('name')) : '';
    const description = typeof attrsByCode.get('description') === 'string' ? String(attrsByCode.get('description')) : '';
    const attributes: Record<string, unknown> = {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      [PART_TEMPLATE_ID_ATTR_CODE]: args.templateId,
      ...(args.attributes ?? {}),
    };
    return createPart({ actor: args.actor, attributes });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listPartBrandLinks(args: {
  partId: string;
  engineBrandId?: string;
}): Promise<{ ok: true; brandLinks: PartEngineBrandLink[] } | { ok: false; error: string }> {
  try {
    const partId = String(args.partId || '').trim();
    if (!partId) return { ok: false, error: 'partId не указан' };
    const engineBrandId = args.engineBrandId ? String(args.engineBrandId).trim() : '';

    const partTypeId = await ensurePartEntityType();
    const partExists = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, partId), eq(entities.typeId, partTypeId), isNull(entities.deletedAt)))
      .limit(1);
    if (!partExists.length) return { ok: false, error: 'деталь не найдена' };

    const links = await (engineBrandId ? listPartBrandLinksInternal({ partId, engineBrandId }) : listPartBrandLinksInternal({ partId }));
    return { ok: true, brandLinks: links };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertPartBrandLink(args: {
  actor: AuthUser;
  partId: string;
  linkId?: string;
  engineBrandId: string;
  assemblyUnitNumber: string;
  quantity: number;
}): Promise<{ ok: true; linkId: string } | { ok: false; error: string }> {
  try {
    const partId = String(args.partId || '').trim();
    const linkId = args.linkId ? String(args.linkId) : '';
    const engineBrandId = String(args.engineBrandId || '').trim();
    const assemblyUnitNumber = String(args.assemblyUnitNumber || '').trim();
    const qty = Number(args.quantity);
    if (!partId) return { ok: false, error: 'partId не указан' };
    if (!engineBrandId) return { ok: false, error: 'engineBrandId не указан' };
    if (!assemblyUnitNumber) return { ok: false, error: 'assemblyUnitNumber не указан' };
    if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: 'количество должно быть неотрицательным числом' };

    const partTypeId = await ensurePartEntityType();
    const partExists = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, partId), eq(entities.typeId, partTypeId), isNull(entities.deletedAt)))
      .limit(1);
    if (!partExists.length) return { ok: false, error: 'деталь не найдена' };

    const partBrandTypeId = await ensurePartEngineBrandEntityType();
    const engineBrandTypeRows = await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(eq(entityTypes.code, EntityTypeCode.EngineBrand))
      .limit(1);
    const engineBrandTypeId = engineBrandTypeRows[0]?.id ? String(engineBrandTypeRows[0].id) : null;
    if (!engineBrandTypeId) return { ok: false, error: 'тип сущности бренда двигателя не найден' };

    const engineBrandEntity = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, engineBrandId), eq(entities.typeId, engineBrandTypeId), isNull(entities.deletedAt)))
      .limit(1);
    if (!engineBrandEntity.length) return { ok: false, error: 'бренд двигателя не найден' };

    const linkAttrDefs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, partBrandTypeId), isNull(attributeDefs.deletedAt)));
    const attrDefByCode = new Map(linkAttrDefs.map((r) => [r.code, String(r.id)]));
    const partIdAttrId = attrDefByCode.get('part_id');
    const engineBrandIdAttrId = attrDefByCode.get('engine_brand_id');
    const asmAttrId = attrDefByCode.get('assembly_unit_number');
    const qtyAttrId = attrDefByCode.get('quantity');
    if (!partIdAttrId || !engineBrandIdAttrId || !asmAttrId || !qtyAttrId) return { ok: false, error: 'атрибуты связи part-engine-brand не подготовлены' };

    const ts = nowMs();
    let targetLinkId = linkId || '';

    if (targetLinkId) {
      const existingLink = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.id, targetLinkId), eq(entities.typeId, partBrandTypeId), isNull(entities.deletedAt)))
        .limit(1);
      if (!existingLink.length) return { ok: false, error: 'связь не найдена' };

      const linkByPart = await listPartBrandLinksInternal({ partId });
      if (!linkByPart.some((link) => link.id === targetLinkId)) {
        return { ok: false, error: 'ссылка не относится к этой детали' };
      }
    } else {
      const existingByPair = await listPartBrandLinksInternal({ partId, engineBrandId });
      targetLinkId = existingByPair[0]?.id || randomUUID();
    }

    if (!linkId && !targetLinkId) targetLinkId = randomUUID();

    const linkExists = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, targetLinkId), eq(entities.typeId, partBrandTypeId), isNull(entities.deletedAt)))
      .limit(1);

    if (!linkExists.length) {
      await db.insert(entities).values({
        id: targetLinkId,
        typeId: partBrandTypeId,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      });
      await recordSyncChanges(syncActor(args.actor), [
        {
          tableName: SyncTableName.Entities,
          rowId: targetLinkId,
          op: 'upsert',
          payload: entityPayload({
            id: targetLinkId,
            typeId: partBrandTypeId,
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
          rowId: targetLinkId,
          ownerUserId: args.actor.id,
          ownerUsername: args.actor.username,
          createdAt: ts,
        })
        .onConflictDoNothing();
    }

    const payloadRows: Array<{ code: string; value: unknown; defId: string }> = [
      { code: 'part_id', value: partId, defId: partIdAttrId },
      { code: 'engine_brand_id', value: engineBrandId, defId: engineBrandIdAttrId },
      { code: 'assembly_unit_number', value: assemblyUnitNumber, defId: asmAttrId },
      { code: 'quantity', value: qty, defId: qtyAttrId },
    ];

    for (const payload of payloadRows) {
      const existing = await db
        .select({ id: attributeValues.id, createdAt: attributeValues.createdAt })
        .from(attributeValues)
        .where(and(eq(attributeValues.entityId, targetLinkId), eq(attributeValues.attributeDefId, payload.defId), isNull(attributeValues.deletedAt)))
        .limit(1);
      const rowId = existing[0]?.id ? String(existing[0].id) : randomUUID();
      const createdAt = existing[0]?.createdAt ? Number(existing[0].createdAt) : ts;
      const valueJson = toValueJson(payload.value);

      await db
        .insert(attributeValues)
        .values({
          id: rowId,
          entityId: targetLinkId,
          attributeDefId: payload.defId,
          valueJson,
          createdAt,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        })
        .onConflictDoUpdate({
          target: [attributeValues.entityId, attributeValues.attributeDefId],
          set: {
            valueJson,
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
            entityId: targetLinkId,
            attributeDefId: payload.defId,
            valueJson,
            createdAt,
            updatedAt: ts,
            deletedAt: null,
            syncStatus: 'pending',
          }),
          ts,
        },
      ]);
    }

    const currentLink = await db
      .select({ id: entities.id, createdAt: entities.createdAt })
      .from(entities)
      .where(and(eq(entities.id, targetLinkId), isNull(entities.deletedAt)))
      .limit(1);
    await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, targetLinkId));
    await recordSyncChanges(syncActor(args.actor), [
      {
        tableName: SyncTableName.Entities,
        rowId: targetLinkId,
        op: 'upsert',
        payload: entityPayload({
          id: targetLinkId,
          typeId: partBrandTypeId,
          createdAt: Number(currentLink[0]?.createdAt ?? ts),
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        }),
        ts,
      },
    ]);

    const auditId = randomUUID();
    await db.insert(auditLog).values({
      id: auditId,
      actor: args.actor.username,
      action: 'partBrandLink.upsert',
      entityId: targetLinkId,
      tableName: 'entities',
      payloadJson: JSON.stringify({ partId, engineBrandId, quantity: qty, assemblyUnitNumber }),
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
          action: 'partBrandLink.upsert',
          entityId: targetLinkId,
          tableName: 'entities',
          payloadJson: JSON.stringify({ partId, engineBrandId, quantity: qty, assemblyUnitNumber }),
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        }),
        ts,
      },
    ]);

    return { ok: true, linkId: targetLinkId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePartBrandLink(args: { actor: AuthUser; partId: string; linkId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const partId = String(args.partId || '').trim();
    const linkId = String(args.linkId || '').trim();
    if (!partId) return { ok: false, error: 'partId не указан' };
    if (!linkId) return { ok: false, error: 'linkId не указан' };

    const partTypeId = await ensurePartEntityType();
    const partExists = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, partId), eq(entities.typeId, partTypeId), isNull(entities.deletedAt)))
      .limit(1);
    if (!partExists.length) return { ok: false, error: 'деталь не найдена' };

    const partBrandTypeId = await ensurePartEngineBrandEntityType();
    const linkExists = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, linkId), eq(entities.typeId, partBrandTypeId), isNull(entities.deletedAt)))
      .limit(1);
    if (!linkExists.length) return { ok: false, error: 'связь не найдена' };

    const links = await listPartBrandLinksInternal({ partId });
    if (!links.some((link) => link.id === linkId)) return { ok: false, error: 'ссылка не относится к этой детали' };

    const ts = nowMs();
    const curRows = await db.select({ id: entities.id, createdAt: entities.createdAt }).from(entities).where(eq(entities.id, linkId)).limit(1);
    await db.update(entities).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, linkId));
    const cur = curRows[0] as any;
    await recordSyncChanges(syncActor(args.actor), [
      {
        tableName: SyncTableName.Entities,
        rowId: linkId,
        op: 'upsert',
        payload: entityPayload({
          id: linkId,
          typeId: partBrandTypeId,
          createdAt: Number(cur?.createdAt ?? ts),
          updatedAt: ts,
          deletedAt: ts,
          syncStatus: 'pending',
        }),
        ts,
      },
    ]);

    const auditId = randomUUID();
    await db.insert(auditLog).values({
      id: auditId,
      actor: args.actor.username,
      action: 'partBrandLink.delete',
      entityId: linkId,
      tableName: 'entities',
      payloadJson: JSON.stringify({ linkId }),
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
          action: 'partBrandLink.delete',
          entityId: linkId,
          tableName: 'entities',
          payloadJson: JSON.stringify({ linkId }),
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

export async function createPart(args: { actor: AuthUser; attributes?: Record<string, unknown> }): Promise<
  | {
      ok: true;
      part: { id: string; createdAt: number; updatedAt: number };
    }
  | { ok: false; error: string }
> {
  try {
    const attributes = { ...(args.attributes ?? {}) };
    const draftName = typeof attributes.name === 'string' ? attributes.name.trim() : '';
    const currentTemplateId =
      typeof attributes[PART_TEMPLATE_ID_ATTR_CODE] === 'string' ? String(attributes[PART_TEMPLATE_ID_ATTR_CODE]).trim() : '';
    if (!currentTemplateId && draftName) {
      const templateTypeId = await ensurePartTemplateEntityType();
      const duplicateTemplateId = await findPartTemplateDuplicateId({ templateTypeId, name: draftName });
      if (duplicateTemplateId) {
        attributes[PART_TEMPLATE_ID_ATTR_CODE] = duplicateTemplateId;
      } else {
        const createdTemplate = await createPartTemplateEntity({
          actor: args.actor,
          attributes: {
            name: draftName,
            ...(typeof attributes.description === 'string' && attributes.description.trim()
              ? { description: attributes.description.trim() }
              : {}),
          },
        });
        attributes[PART_TEMPLATE_ID_ATTR_CODE] = createdTemplate.entityId;
      }
    }

    const typeId = await ensurePartEntityType();
    const attrDefs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)));

    const duplicateId = await findPartDuplicateId(Object.keys(attributes).length > 0 ? { typeId, attrDefs, attributes } : { typeId, attrDefs });
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
    if (Object.keys(attributes).length > 0) {
      const attrDefsFull = await db
        .select()
        .from(attributeDefs)
        .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)));
      for (const [code, value] of Object.entries(attributes)) {
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
      payloadJson: JSON.stringify({ partId: id, attributes }),
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
          payloadJson: JSON.stringify({ partId: id, attributes }),
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

    await refreshPartWarehouseNomenclatureLinks().catch(() => undefined);

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
    if (!entityRows.length) return { ok: false, error: 'деталь не найдена' };

    // Находим определение атрибута
    const attrDefRows = await db
      .select()
      .from(attributeDefs)
      .where(
        and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, attrCode), isNull(attributeDefs.deletedAt)),
      )
      .limit(1);
    if (!attrDefRows.length) return { ok: false, error: 'атрибут не найден' };

    const attrDef = attrDefRows[0];
    if (!attrDef) return { ok: false, error: 'атрибут не найден' };
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

    if (attrCode === 'name' || attrCode === 'description' || attrCode === PART_TEMPLATE_ID_ATTR_CODE) {
      await ensureExistingPartTemplateAssignments();
    }

    if (attrCode === 'name' || attrCode === 'article' || attrCode === PART_TEMPLATE_ID_ATTR_CODE) {
      await refreshPartWarehouseNomenclatureLinks().catch(() => undefined);
    }

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

    await refreshPartWarehouseNomenclatureLinks().catch(() => undefined);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

