import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import { EntityTypeCode } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, auditLog, entities, entityTypes } from '../database/schema.js';

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

async function ensurePartEntityType(): Promise<string> {
  const existing = await getPartEntityTypeId();
  if (existing) return existing;

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
  return id;
}

export async function listParts(args?: { q?: string; limit?: number }): Promise<
  | {
      ok: true;
      parts: {
        id: string;
        name?: string;
        article?: string;
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

    const nameAttrId = nameAttr[0]?.id;
    const articleAttrId = articleAttr[0]?.id;

    const entityIds = entityRows.map((r) => r.id);
    
    const attrRows = nameAttrId || articleAttrId
      ? await db
          .select({
            entityId: attributeValues.entityId,
            attributeDefId: attributeValues.attributeDefId,
            valueJson: attributeValues.valueJson,
          })
          .from(attributeValues)
          .where(
            and(
              nameAttrId && articleAttrId
                ? or(eq(attributeValues.attributeDefId, nameAttrId), eq(attributeValues.attributeDefId, articleAttrId))
                : nameAttrId
                  ? eq(attributeValues.attributeDefId, nameAttrId)
                  : eq(attributeValues.attributeDefId, articleAttrId!),
              inArray(attributeValues.entityId, entityIds),
              isNull(attributeValues.deletedAt),
            ),
          )
          .limit(10_000)
      : [];

    const attrsByEntity: Record<string, { name?: string; article?: string }> = {};
    for (const attr of attrRows) {
      if (!attrsByEntity[attr.entityId]) attrsByEntity[attr.entityId] = {};
      const val = attr.valueJson ? safeJsonParse(attr.valueJson) : null;
      if (attr.attributeDefId === nameAttrId && typeof val === 'string') {
        attrsByEntity[attr.entityId].name = val;
      } else if (attr.attributeDefId === articleAttrId && typeof val === 'string') {
        attrsByEntity[attr.entityId].article = val;
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

    const parts = filtered.map((e) => ({
      id: e.id,
      name: attrsByEntity[e.id]?.name,
      article: attrsByEntity[e.id]?.article,
      createdAt: Number(e.createdAt),
      updatedAt: Number(e.updatedAt),
    }));

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

export async function createPart(args: { actor: string; attributes?: Record<string, unknown> }): Promise<
  | {
      ok: true;
      part: { id: string; createdAt: number; updatedAt: number };
    }
  | { ok: false; error: string }
> {
  try {
    const typeId = await ensurePartEntityType();
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

    // Устанавливаем начальные атрибуты если переданы
    if (args.attributes) {
      const attrDefs = await db
        .select()
        .from(attributeDefs)
        .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)));

      for (const [code, value] of Object.entries(args.attributes)) {
        const def = attrDefs.find((ad) => ad.code === code);
        if (!def) continue;

        await db
          .insert(attributeValues)
          .values({
            id: randomUUID(),
            entityId: id,
            attributeDefId: def.id,
            valueJson: JSON.stringify(value),
            createdAt: ts,
            updatedAt: ts,
            deletedAt: null,
            syncStatus: 'pending',
          })
          .onConflictDoUpdate({
            target: [attributeValues.entityId, attributeValues.attributeDefId],
            set: {
              valueJson: JSON.stringify(value),
              updatedAt: ts,
              syncStatus: 'pending',
            },
          });
      }
    }

    await db.insert(auditLog).values({
      id: randomUUID(),
      actor: args.actor,
      action: 'part.create',
      entityId: id,
      tableName: 'entities',
      payloadJson: JSON.stringify({ partId: id, attributes: args.attributes }),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });

    return { ok: true, part: { id, createdAt: ts, updatedAt: ts } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function updatePartAttribute(args: {
  partId: string;
  attributeCode: string;
  value: unknown;
  actor: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
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
    const ts = nowMs();

    // Обновляем или создаем значение атрибута
    await db
      .insert(attributeValues)
      .values({
        id: randomUUID(),
        entityId: partId,
        attributeDefId: attrDef.id,
        valueJson: JSON.stringify(args.value),
        createdAt: ts,
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

    // Обновляем updatedAt у сущности
    await db.update(entities).set({ updatedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, partId));

    await db.insert(auditLog).values({
      id: randomUUID(),
      actor: args.actor,
      action: 'part.update_attribute',
      entityId: partId,
      tableName: 'attribute_values',
      payloadJson: JSON.stringify({ partId, attributeCode: attrCode, value: args.value }),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePart(args: { partId: string; actor: string }): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const typeId = await ensurePartEntityType();
    const partId = String(args.partId || '');
    const ts = nowMs();

    // Мягкое удаление: помечаем deleted_at
    await db.update(entities).set({ deletedAt: ts, syncStatus: 'pending' }).where(eq(entities.id, partId));
    await db
      .update(attributeValues)
      .set({ deletedAt: ts, syncStatus: 'pending' })
      .where(eq(attributeValues.entityId, partId));

    await db.insert(auditLog).values({
      id: randomUUID(),
      actor: args.actor,
      action: 'part.delete',
      entityId: partId,
      tableName: 'entities',
      payloadJson: JSON.stringify({ partId }),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

