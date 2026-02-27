import { and, eq, isNull } from 'drizzle-orm';

import { AttributeDataType, EntityTypeCode } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { createEntity, setEntityAttribute, upsertAttributeDef, upsertEntityType } from '../services/adminMasterdataService.js';

const ACTOR = { id: '', username: 'system' };

async function ensureEntityType(code: string, name: string) {
  const existing = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  if (existing[0]) return String(existing[0].id);
  const r = await upsertEntityType(ACTOR, { code, name });
  if (!r.ok || !r.id) throw new Error(`Не удалось создать тип сущности: ${code}`);
  return r.id;
}

async function ensureAttrDef(entityTypeId: string, code: string, name: string, dataType: string, sortOrder: number, metaJson?: string | null) {
  const existing = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existing[0]) return String(existing[0].id);
  const r = await upsertAttributeDef(ACTOR, {
    entityTypeId,
    code,
    name,
    dataType,
    sortOrder,
    metaJson: metaJson ?? null,
  });
  if (!r.ok || !r.id) throw new Error(`Не удалось создать определение атрибута: ${entityTypeId} ${code}`);
  return r.id;
}

async function findCategoryByName(categoryTypeId: string, nameDefId: string, name: string) {
  const rows = await db
    .select({ entityId: attributeValues.entityId })
    .from(attributeValues)
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(attributeValues.attributeDefId, nameDefId as any),
        eq(attributeValues.valueJson, JSON.stringify(name)),
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        eq(entities.typeId, categoryTypeId as any),
      ),
    )
    .limit(1);
  return rows[0]?.entityId ? String(rows[0].entityId) : null;
}

async function ensureCategory(categoryTypeId: string, nameDefId: string, name: string, parentId?: string | null) {
  const existing = await findCategoryByName(categoryTypeId, nameDefId, name);
  if (existing) return existing;
  const created = await createEntity(ACTOR, categoryTypeId);
  if (!created.ok || !created.id) throw new Error(`Не удалось создать категорию: ${name}`);
  await setEntityAttribute(ACTOR, created.id, 'name', name);
  if (parentId) await setEntityAttribute(ACTOR, created.id, 'parent_id', parentId);
  return created.id;
}

async function main() {
  const categoryTypeId = await ensureEntityType(EntityTypeCode.Category, 'Категории');
  const nameDefId = await ensureAttrDef(categoryTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  const _parentDefId = await ensureAttrDef(
    categoryTypeId,
    'parent_id',
    'Родительская категория',
    AttributeDataType.Link,
    20,
    JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Category }),
  );

  const base = ['Детали', 'Двигатели', 'Канцтовары'];
  const created: string[] = [];
  for (const name of base) {
    const id = await ensureCategory(categoryTypeId, nameDefId, name, null);
    created.push(id);
  }

  console.log(JSON.stringify({ ok: true, created }));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
});
