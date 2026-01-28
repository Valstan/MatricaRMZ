import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, changeLog, entities, entityTypes, rowOwners } from '../database/schema.js';

type Actor = { id: string; username: string };

function nowMs() {
  return Date.now();
}

function normalizeOpFromDeletedAt(deletedAt: number | null | undefined) {
  return deletedAt ? 'delete' : 'upsert';
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

async function insertChangeLog(tableName: SyncTableName, rowId: string, payload: unknown) {
  await db.insert(changeLog).values({
    tableName,
    rowId: rowId as any,
    op: normalizeOpFromDeletedAt((payload as any)?.deleted_at ?? null),
    payloadJson: JSON.stringify(payload),
    createdAt: nowMs(),
  });
}

async function ensureOwner(tableName: SyncTableName, rowId: string, actor: Actor) {
  if (!actor.id) return;
  await db
    .insert(rowOwners)
    .values({
      id: randomUUID(),
      tableName,
      rowId: rowId as any,
      ownerUserId: actor.id as any,
      ownerUsername: actor.username ?? null,
      createdAt: nowMs(),
    })
    .onConflictDoNothing();
}

async function getOwnerForEntity(entityId: string): Promise<{ ownerUserId: string | null; ownerUsername: string | null } | null> {
  const rows = await db
    .select({ ownerUserId: rowOwners.ownerUserId, ownerUsername: rowOwners.ownerUsername })
    .from(rowOwners)
    .where(and(eq(rowOwners.tableName, SyncTableName.Entities), eq(rowOwners.rowId, entityId as any)))
    .limit(1);
  if (!rows[0]) return null;
  return {
    ownerUserId: rows[0].ownerUserId ? String(rows[0].ownerUserId) : null,
    ownerUsername: rows[0].ownerUsername ? String(rows[0].ownerUsername) : null,
  };
}

async function getDefsByType(entityTypeId: string) {
  const defs = await db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), isNull(attributeDefs.deletedAt)))
    .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code))
    .limit(5000);
  const byCode: Record<string, string> = {};
  for (const d of defs) byCode[String(d.code)] = String(d.id);
  return { defs, byCode };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toValueJson(value: unknown): string | null {
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return json;
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

async function findDuplicateEntityId(args: {
  entityId: string;
  entityTypeId: string;
  nextAttrDefId: string;
  nextValueJson: string | null;
}): Promise<string | null> {
  const { entityId, entityTypeId, nextAttrDefId, nextValueJson } = args;
  const { defs, byCode } = await getDefsByType(entityTypeId);
  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;
  if (!labelDefId) return null;

  const defIds = defs.map((d) => String(d.id));
  if (defIds.length === 0) return null;

  const currentValues = await db
    .select({ attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, entityId as any), inArray(attributeValues.attributeDefId, defIds as any), isNull(attributeValues.deletedAt)))
    .limit(50_000);
  const valueByDefId = new Map<string, string | null>();
  for (const row of currentValues as any[]) {
    valueByDefId.set(String(row.attributeDefId), row.valueJson == null ? null : String(row.valueJson));
  }
  valueByDefId.set(nextAttrDefId, nextValueJson);

  const labelValueJson = valueByDefId.get(labelDefId) ?? null;
  if (!normalizeValueForCompare(labelValueJson)) return null;

  const candidates = await db
    .select({ entityId: attributeValues.entityId })
    .from(attributeValues)
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(attributeValues.attributeDefId, labelDefId as any),
        eq(attributeValues.valueJson, labelValueJson),
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        eq(entities.typeId, entityTypeId as any),
      ),
    )
    .limit(5000);
  const candidateIds = candidates.map((r) => String(r.entityId)).filter((id) => id !== entityId);
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

async function getEntityDisplayName(entityId: string, entityTypeId: string): Promise<string | null> {
  const { byCode } = await getDefsByType(entityTypeId);
  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;
  if (!labelDefId) return null;
  const v = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, entityId as any), eq(attributeValues.attributeDefId, labelDefId as any)))
    .limit(1);
  const val = v[0]?.valueJson ? safeJsonParse(String(v[0].valueJson)) : null;
  if (val == null || val === '') return null;
  return String(val);
}

async function findIncomingLinkRows(entityId: string): Promise<
  {
    valueId: string;
    fromEntityId: string;
    fromEntityTypeId: string;
    fromEntityTypeCode: string;
    fromEntityTypeName: string;
    attributeDefId: string;
    attributeCode: string;
    attributeName: string;
  }[]
> {
  const target = JSON.stringify(entityId);
  const rows = await db
    .select({
      valueId: attributeValues.id,
      fromEntityId: attributeValues.entityId,
      attributeDefId: attributeDefs.id,
      attributeCode: attributeDefs.code,
      attributeName: attributeDefs.name,
      fromEntityTypeId: entities.typeId,
      fromEntityTypeCode: entityTypes.code,
      fromEntityTypeName: entityTypes.name,
    })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeValues.attributeDefId, attributeDefs.id))
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .innerJoin(entityTypes, eq(entities.typeId, entityTypes.id))
    .where(
      and(
        isNull(attributeValues.deletedAt),
        eq(attributeValues.valueJson, target),
        isNull(attributeDefs.deletedAt),
        eq(attributeDefs.dataType, 'link'),
        isNull(entities.deletedAt),
        isNull(entityTypes.deletedAt),
      ),
    )
    .limit(10_000);

  return rows.map((r) => ({
    valueId: String(r.valueId),
    fromEntityId: String(r.fromEntityId),
    fromEntityTypeId: String(r.fromEntityTypeId),
    fromEntityTypeCode: String(r.fromEntityTypeCode),
    fromEntityTypeName: String(r.fromEntityTypeName),
    attributeDefId: String(r.attributeDefId),
    attributeCode: String(r.attributeCode),
    attributeName: String(r.attributeName),
  }));
}

export async function listEntityTypes() {
  return db.select().from(entityTypes).where(isNull(entityTypes.deletedAt)).orderBy(asc(entityTypes.code)).limit(2000);
}

export async function upsertEntityType(actor: Actor, args: { id?: string; code: string; name: string }) {
  const ts = nowMs();
  const code = args.code.trim();
  const name = args.name.trim();
  const existingByCode = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  if (existingByCode[0] && String(existingByCode[0].id) !== String(args.id ?? '')) {
    return { ok: false as const, error: 'code already exists' };
  }

  const id = args.id ?? randomUUID();
  const existing = await db.select().from(entityTypes).where(eq(entityTypes.id, id as any)).limit(1);
  const createdAt = existing[0]?.createdAt ? Number(existing[0].createdAt) : ts;

  await db
    .insert(entityTypes)
    .values({
      id,
      code,
      name,
      createdAt,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    })
    .onConflictDoUpdate({
      target: entityTypes.id,
      set: { code, name, updatedAt: ts, deletedAt: null, syncStatus: 'synced' },
    });

  const row = { id, code, name, createdAt, updatedAt: ts, deletedAt: null, syncStatus: 'synced' };
  await insertChangeLog(SyncTableName.EntityTypes, id, entityTypePayload(row));
  if (!existing[0]) await ensureOwner(SyncTableName.EntityTypes, id, actor);

  return { ok: true as const, id };
}

export async function getEntityTypeDeleteInfo(entityTypeId: string) {
  const t = await db.select().from(entityTypes).where(eq(entityTypes.id, entityTypeId as any)).limit(1);
  if (!t[0] || t[0].deletedAt != null) return { ok: false as const, error: 'Раздел не найден' };

  const defsCount = await db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), isNull(attributeDefs.deletedAt)))
    .then((rows) => rows.length);

  const entitiesCount = await db
    .select()
    .from(entities)
    .where(and(eq(entities.typeId, entityTypeId as any), isNull(entities.deletedAt)))
    .then((rows) => rows.length);

  return {
    ok: true as const,
    type: { id: String(t[0].id), code: String(t[0].code), name: String(t[0].name) },
    counts: { entities: entitiesCount, defs: defsCount },
  };
}

export async function deleteEntityType(
  actor: Actor,
  entityTypeId: string,
  opts: { deleteEntities: boolean; deleteDefs: boolean },
) {
  const ts = nowMs();
  const t = await db.select().from(entityTypes).where(eq(entityTypes.id, entityTypeId as any)).limit(1);
  if (!t[0] || t[0].deletedAt != null) return { ok: false as const, error: 'Раздел не найден' };

  let deletedEntities = 0;
  if (opts.deleteEntities) {
    const rows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.typeId, entityTypeId as any), isNull(entities.deletedAt)))
      .limit(50_000);
    for (const e of rows) {
      const r = await detachIncomingLinksAndSoftDeleteEntity(actor, String(e.id));
      if (!r.ok) return { ok: false as const, error: r.error ?? 'failed to delete entity' };
      deletedEntities += 1;
    }
  }

  if (opts.deleteDefs) {
    const defs = await db
      .select()
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), isNull(attributeDefs.deletedAt)))
      .limit(20_000);
    for (const d of defs as any[]) {
      await db
        .update(attributeDefs)
        .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(attributeDefs.id, d.id));
      const payload = attributeDefPayload({
        id: String(d.id),
        entityTypeId: String(d.entityTypeId),
        code: String(d.code),
        name: String(d.name),
        dataType: String(d.dataType),
        isRequired: Boolean(d.isRequired),
        sortOrder: Number(d.sortOrder ?? 0),
        metaJson: d.metaJson ? String(d.metaJson) : null,
        createdAt: Number(d.createdAt),
        updatedAt: ts,
        deletedAt: ts,
        syncStatus: 'synced',
      });
      await insertChangeLog(SyncTableName.AttributeDefs, String(d.id), payload);
    }
  }

  await db.update(entityTypes).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(eq(entityTypes.id, entityTypeId as any));
  const payload = entityTypePayload({
    id: String(t[0].id),
    code: String(t[0].code),
    name: String(t[0].name),
    createdAt: Number(t[0].createdAt),
    updatedAt: ts,
    deletedAt: ts,
    syncStatus: 'synced',
  });
  await insertChangeLog(SyncTableName.EntityTypes, entityTypeId, payload);

  return { ok: true as const, deletedEntities };
}

export async function listAttributeDefsByEntityType(entityTypeId: string) {
  return db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), isNull(attributeDefs.deletedAt)))
    .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code))
    .limit(5000);
}

export async function upsertAttributeDef(
  actor: Actor,
  args: {
    id?: string;
    entityTypeId: string;
    code: string;
    name: string;
    dataType: string;
    isRequired?: boolean;
    sortOrder?: number;
    metaJson?: string | null;
  },
) {
  const ts = nowMs();
  const entityTypeId = String(args.entityTypeId);
  const code = args.code.trim();
  const name = args.name.trim();
  const dataType = args.dataType;

  const existingByKey = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existingByKey[0] && String(existingByKey[0].id) !== String(args.id ?? '')) {
    return { ok: false as const, error: 'code already exists for this type' };
  }

  const id = args.id ?? randomUUID();
  const existing = await db.select().from(attributeDefs).where(eq(attributeDefs.id, id as any)).limit(1);
  const createdAt = existing[0]?.createdAt ? Number(existing[0].createdAt) : ts;

  await db
    .insert(attributeDefs)
    .values({
      id,
      entityTypeId,
      code,
      name,
      dataType,
      isRequired: !!args.isRequired,
      sortOrder: args.sortOrder ?? 0,
      metaJson: args.metaJson ?? null,
      createdAt,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    })
    .onConflictDoUpdate({
      target: attributeDefs.id,
      set: {
        entityTypeId,
        code,
        name,
        dataType,
        isRequired: !!args.isRequired,
        sortOrder: args.sortOrder ?? 0,
        metaJson: args.metaJson ?? null,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      },
    });

  const payload = attributeDefPayload({
    id,
    entityTypeId,
    code,
    name,
    dataType,
    isRequired: !!args.isRequired,
    sortOrder: args.sortOrder ?? 0,
    metaJson: args.metaJson ?? null,
    createdAt,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await insertChangeLog(SyncTableName.AttributeDefs, id, payload);
  if (!existing[0]) await ensureOwner(SyncTableName.AttributeDefs, id, actor);

  return { ok: true as const, id };
}

export async function getAttributeDefDeleteInfo(attributeDefId: string) {
  const d = await db.select().from(attributeDefs).where(eq(attributeDefs.id, attributeDefId as any)).limit(1);
  if (!d[0] || d[0].deletedAt != null) return { ok: false as const, error: 'Свойство не найдено' };

  const valuesCount = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.attributeDefId, attributeDefId as any), isNull(attributeValues.deletedAt)))
    .then((rows) => rows.length);

  return {
    ok: true as const,
    def: {
      id: String(d[0].id),
      entityTypeId: String(d[0].entityTypeId),
      code: String(d[0].code),
      name: String(d[0].name),
      dataType: String(d[0].dataType),
      metaJson: d[0].metaJson ? String(d[0].metaJson) : null,
    },
    counts: { values: valuesCount },
  };
}

export async function deleteAttributeDef(actor: Actor, attributeDefId: string, opts: { deleteValues: boolean }) {
  const ts = nowMs();
  const d = await db.select().from(attributeDefs).where(eq(attributeDefs.id, attributeDefId as any)).limit(1);
  if (!d[0] || d[0].deletedAt != null) return { ok: false as const, error: 'Свойство не найдено' };

  if (opts.deleteValues) {
    const affected = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.attributeDefId, attributeDefId as any), isNull(attributeValues.deletedAt)))
      .limit(200_000);

    const affectedEntityIds = new Set<string>();
    for (const r of affected as any[]) {
      affectedEntityIds.add(String(r.entityId));
      await db
        .update(attributeValues)
        .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(attributeValues.id, r.id));
      const payload = attributeValuePayload({
        id: String(r.id),
        entityId: String(r.entityId),
        attributeDefId: String(r.attributeDefId),
        valueJson: r.valueJson == null ? null : String(r.valueJson),
        createdAt: Number(r.createdAt),
        updatedAt: ts,
        deletedAt: ts,
        syncStatus: 'synced',
      });
      await insertChangeLog(SyncTableName.AttributeValues, String(r.id), payload);
    }

    for (const entityId of affectedEntityIds) {
      const cur = await db.select().from(entities).where(eq(entities.id, entityId as any)).limit(1);
      if (!cur[0]) continue;
      await db.update(entities).set({ updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, entityId as any));
      const payload = entityPayload({
        id: String(cur[0].id),
        typeId: String(cur[0].typeId),
        createdAt: Number(cur[0].createdAt),
        updatedAt: ts,
        deletedAt: cur[0].deletedAt == null ? null : Number(cur[0].deletedAt),
        syncStatus: 'synced',
      });
      await insertChangeLog(SyncTableName.Entities, entityId, payload);
    }
  }

  await db.update(attributeDefs).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(eq(attributeDefs.id, attributeDefId as any));
  const payload = attributeDefPayload({
    id: String(d[0].id),
    entityTypeId: String(d[0].entityTypeId),
    code: String(d[0].code),
    name: String(d[0].name),
    dataType: String(d[0].dataType),
    isRequired: Boolean(d[0].isRequired),
    sortOrder: Number(d[0].sortOrder ?? 0),
    metaJson: d[0].metaJson ? String(d[0].metaJson) : null,
    createdAt: Number(d[0].createdAt),
    updatedAt: ts,
    deletedAt: ts,
    syncStatus: 'synced',
  });
  await insertChangeLog(SyncTableName.AttributeDefs, attributeDefId, payload);

  return { ok: true as const };
}

export async function listEntitiesByType(entityTypeId: string) {
  const rows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.typeId, entityTypeId as any), isNull(entities.deletedAt)))
    .orderBy(desc(entities.updatedAt))
    .limit(2000);

  const { byCode } = await getDefsByType(entityTypeId);
  const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
  const labelDefId = labelKeys.map((k) => byCode[k]).find(Boolean) ?? null;

  const labelMap = new Map<string, string>();
  if (labelDefId && rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const vals = await db
      .select()
      .from(attributeValues)
      .where(and(inArray(attributeValues.entityId, ids as any), eq(attributeValues.attributeDefId, labelDefId as any), isNull(attributeValues.deletedAt)))
      .limit(50_000);
    for (const v of vals as any[]) {
      const val = v.valueJson ? safeJsonParse(String(v.valueJson)) : null;
      if (val != null && val !== '') labelMap.set(String(v.entityId), String(val));
    }
  }

  return rows.map((e) => ({
    id: String(e.id),
    typeId: String(e.typeId),
    updatedAt: Number(e.updatedAt),
    syncStatus: String(e.syncStatus),
    displayName: labelMap.get(String(e.id)),
  }));
}

export async function createEntity(actor: Actor, entityTypeId: string) {
  const ts = nowMs();
  const id = randomUUID();
  await db.insert(entities).values({
    id,
    typeId: entityTypeId as any,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  const payload = entityPayload({
    id,
    typeId: entityTypeId,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await insertChangeLog(SyncTableName.Entities, id, payload);
  await ensureOwner(SyncTableName.Entities, id, actor);
  return { ok: true as const, id };
}

export async function getEntityDetails(entityId: string) {
  const e = await db.select().from(entities).where(eq(entities.id, entityId as any)).limit(1);
  if (!e[0]) throw new Error('Сущность не найдена');

  const { byCode } = await getDefsByType(String(e[0].typeId));
  const attrs: Record<string, unknown> = {};
  for (const [code, defId] of Object.entries(byCode)) {
    const v = await db
      .select()
      .from(attributeValues)
      .where(and(eq(attributeValues.entityId, entityId as any), eq(attributeValues.attributeDefId, defId as any)))
      .limit(1);
    if (v[0]?.valueJson) attrs[code] = safeJsonParse(String(v[0].valueJson));
  }

  return {
    id: String(e[0].id),
    typeId: String(e[0].typeId),
    createdAt: Number(e[0].createdAt),
    updatedAt: Number(e[0].updatedAt),
    deletedAt: e[0].deletedAt == null ? null : Number(e[0].deletedAt),
    syncStatus: String(e[0].syncStatus),
    attributes: attrs,
  };
}

export async function setEntityAttribute(actor: Actor, entityId: string, code: string, value: unknown) {
  const ts = nowMs();
  const e = await db.select().from(entities).where(eq(entities.id, entityId as any)).limit(1);
  if (!e[0]) return { ok: false as const, error: 'Сущность не найдена' };

  const { byCode } = await getDefsByType(String(e[0].typeId));
  const defId = byCode[code];
  if (!defId) return { ok: false as const, error: `Неизвестный атрибут: ${code}` };

  const existing = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, entityId as any), eq(attributeValues.attributeDefId, defId as any)))
    .limit(1);

  const payloadJson = toValueJson(value);
  const duplicateId = await findDuplicateEntityId({
    entityId,
    entityTypeId: String(e[0].typeId),
    nextAttrDefId: defId,
    nextValueJson: payloadJson,
  });
  if (duplicateId) {
    return { ok: false as const, error: `Дубликат: уже существует объект ${duplicateId}` };
  }
  if (existing[0]) {
    await db
      .update(attributeValues)
      .set({ valueJson: payloadJson, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(attributeValues.id, existing[0].id));
    const payload = attributeValuePayload({
      id: String(existing[0].id),
      entityId,
      attributeDefId: defId,
      valueJson: payloadJson,
      createdAt: Number(existing[0].createdAt),
      updatedAt: ts,
      deletedAt: existing[0].deletedAt == null ? null : Number(existing[0].deletedAt),
      syncStatus: 'synced',
    });
    await insertChangeLog(SyncTableName.AttributeValues, String(existing[0].id), payload);
  } else {
    const id = randomUUID();
    await db.insert(attributeValues).values({
      id,
      entityId: entityId as any,
      attributeDefId: defId as any,
      valueJson: payloadJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    const payload = attributeValuePayload({
      id,
      entityId,
      attributeDefId: defId,
      valueJson: payloadJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await insertChangeLog(SyncTableName.AttributeValues, id, payload);

    const owner = (await getOwnerForEntity(entityId)) ?? { ownerUserId: actor.id ?? null, ownerUsername: actor.username ?? null };
    if (owner.ownerUserId) {
      await db
        .insert(rowOwners)
        .values({
          id: randomUUID(),
          tableName: SyncTableName.AttributeValues,
          rowId: id as any,
          ownerUserId: owner.ownerUserId as any,
          ownerUsername: owner.ownerUsername,
          createdAt: ts,
        })
        .onConflictDoNothing();
    }
  }

  await db.update(entities).set({ updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, entityId as any));
  const payload = entityPayload({
    id: String(e[0].id),
    typeId: String(e[0].typeId),
    createdAt: Number(e[0].createdAt),
    updatedAt: ts,
    deletedAt: e[0].deletedAt == null ? null : Number(e[0].deletedAt),
    syncStatus: 'synced',
  });
  await insertChangeLog(SyncTableName.Entities, entityId, payload);

  return { ok: true as const };
}

export async function softDeleteEntity(actor: Actor, entityId: string) {
  const ts = nowMs();
  const e = await db.select().from(entities).where(eq(entities.id, entityId as any)).limit(1);
  if (!e[0]) return { ok: false as const, error: 'Сущность не найдена' };
  await db.update(entities).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, entityId as any));
  const payload = entityPayload({
    id: String(e[0].id),
    typeId: String(e[0].typeId),
    createdAt: Number(e[0].createdAt),
    updatedAt: ts,
    deletedAt: ts,
    syncStatus: 'synced',
  });
  await insertChangeLog(SyncTableName.Entities, entityId, payload);
  return { ok: true as const };
}

export async function getIncomingLinksForEntity(entityId: string) {
  try {
    const rows = await findIncomingLinkRows(entityId);
    const cache = new Map<string, string | null>();
    const out: any[] = [];
    for (const r of rows) {
      const key = `${r.fromEntityTypeId}:${r.fromEntityId}`;
      let display = cache.get(key) ?? null;
      if (!cache.has(key)) {
        display = await getEntityDisplayName(r.fromEntityId, r.fromEntityTypeId);
        cache.set(key, display);
      }
      out.push({ ...r, fromEntityDisplayName: display });
    }
    const cleaned = out.sort((a, b) => {
      const t = String(a.fromEntityTypeName).localeCompare(String(b.fromEntityTypeName), 'ru');
      if (t !== 0) return t;
      const da = String(a.fromEntityDisplayName ?? '').toLowerCase();
      const dbb = String(b.fromEntityDisplayName ?? '').toLowerCase();
      if (da !== dbb) return da.localeCompare(dbb, 'ru');
      return String(a.fromEntityId).localeCompare(String(b.fromEntityId));
    });
    return { ok: true as const, links: cleaned };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function detachIncomingLinksAndSoftDeleteEntity(actor: Actor, entityId: string) {
  try {
    const ts = nowMs();
    const rows = await findIncomingLinkRows(entityId);
    for (const r of rows) {
      const current = await db.select().from(attributeValues).where(eq(attributeValues.id, r.valueId as any)).limit(1);
      if (!current[0]) continue;
      await db
        .update(attributeValues)
        .set({ valueJson: JSON.stringify(null), updatedAt: ts, syncStatus: 'synced' })
        .where(eq(attributeValues.id, r.valueId as any));
      const payload = attributeValuePayload({
        id: String(current[0].id),
        entityId: String(current[0].entityId),
        attributeDefId: String(current[0].attributeDefId),
        valueJson: JSON.stringify(null),
        createdAt: Number(current[0].createdAt),
        updatedAt: ts,
        deletedAt: current[0].deletedAt == null ? null : Number(current[0].deletedAt),
        syncStatus: 'synced',
      });
      await insertChangeLog(SyncTableName.AttributeValues, String(current[0].id), payload);

      const ent = await db.select().from(entities).where(eq(entities.id, r.fromEntityId as any)).limit(1);
      if (ent[0]) {
        await db.update(entities).set({ updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, r.fromEntityId as any));
        const ePayload = entityPayload({
          id: String(ent[0].id),
          typeId: String(ent[0].typeId),
          createdAt: Number(ent[0].createdAt),
          updatedAt: ts,
          deletedAt: ent[0].deletedAt == null ? null : Number(ent[0].deletedAt),
          syncStatus: 'synced',
        });
        await insertChangeLog(SyncTableName.Entities, String(ent[0].id), ePayload);
      }
    }

    const del = await softDeleteEntity(actor, entityId);
    if (!del.ok) return { ok: false as const, error: del.error ?? 'delete failed' };
    return { ok: true as const, detached: rows.length };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

