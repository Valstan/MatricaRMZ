import 'dotenv/config';

import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';

const GROUPS: Array<{ name: string; kind: string }> = [
  { name: 'Производство · Готовая продукция (двигатели)', kind: 'Продукция' },
  { name: 'Производство · Сборочные единицы (узлы)', kind: 'Продукция' },
  { name: 'Производство · Детали собственного изготовления', kind: 'Продукция' },
  { name: 'Закупка · Покупные детали и комплектующие', kind: 'Закупка' },
  { name: 'Закупка · Инструмент и оснастка', kind: 'Закупка' },
  { name: 'Закупка · Материалы и сырьё', kind: 'Закупка' },
  { name: 'Закупка · Расходные материалы', kind: 'Закупка' },
  { name: 'Закупка · Товары', kind: 'Закупка' },
  { name: 'Услуги · Собственные', kind: 'Услуги' },
  { name: 'Услуги · Подрядчиков', kind: 'Услуги' },
];

async function ensureAttrDef(typeId: string, code: string, name: string, dataType: string): Promise<string> {
  const existing = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return String(existing[0].id);
  const id = randomUUID();
  const ts = Date.now();
  await db.insert(attributeDefs).values({
    id,
    entityTypeId: typeId as any,
    code,
    name,
    dataType,
    isRequired: false,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  return id;
}

async function main() {
  const ts = Date.now();
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'nomenclature_group'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : '';
  if (!typeId) {
    console.error('[группы] тип nomenclature_group не найден; убедитесь что миграции выполнены');
    process.exitCode = 1;
    return;
  }

  const nameDefId = await ensureAttrDef(typeId, 'name', 'Наименование', 'text');
  const kindDefId = await ensureAttrDef(typeId, 'kind', 'Раздел', 'text');

  const existingRows = await db
    .select({ id: entities.id, valueJson: attributeValues.valueJson })
    .from(entities)
    .innerJoin(
      attributeValues,
      and(
        eq(attributeValues.entityId, entities.id),
        eq(attributeValues.attributeDefId, nameDefId as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)));

  const existingNames = new Set(
    existingRows
      .map((row) => {
        try {
          return String(JSON.parse(String(row.valueJson ?? 'null')) ?? '').trim();
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  );

  let created = 0;
  for (const group of GROUPS) {
    if (existingNames.has(group.name)) continue;
    const entityId = randomUUID();
    await db.insert(entities).values({
      id: entityId,
      typeId: typeId as any,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await db.insert(attributeValues).values({
      id: randomUUID(),
      entityId: entityId as any,
      attributeDefId: nameDefId as any,
      valueJson: JSON.stringify(group.name),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await db.insert(attributeValues).values({
      id: randomUUID(),
      entityId: entityId as any,
      attributeDefId: kindDefId as any,
      valueJson: JSON.stringify(group.kind),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    created += 1;
  }

  console.log(`[группы номенклатуры] обработано=${GROUPS.length}, создано=${created}, уже существовало=${GROUPS.length - created}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
