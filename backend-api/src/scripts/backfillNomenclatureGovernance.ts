import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes, erpNomenclature } from '../database/schema.js';

function nowMs() {
  return Date.now();
}

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

async function ensureTypeAndDefs(typeCode: string, typeName: string, defs: Array<{ code: string; name: string; dataType: string; sortOrder: number }>) {
  const ts = nowMs();
  let typeId = (
    await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(and(eq(entityTypes.code, typeCode), isNull(entityTypes.deletedAt)))
      .limit(1)
  )[0]?.id as string | undefined;
  if (!typeId) {
    typeId = randomUUID();
    await db.insert(entityTypes).values({
      id: typeId,
      code: typeCode,
      name: typeName,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
      lastServerSeq: null,
    });
  }
  const existingDefs = await db
    .select({ code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)));
  const known = new Set(existingDefs.map((row) => String(row.code)));
  for (const def of defs) {
    if (known.has(def.code)) continue;
    await db.insert(attributeDefs).values({
      id: randomUUID(),
      entityTypeId: typeId as any,
      code: def.code,
      name: def.name,
      dataType: def.dataType,
      sortOrder: def.sortOrder,
      isRequired: false,
      metaJson: null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
      lastServerSeq: null,
    });
  }
  return typeId;
}

async function ensureTemplate(code: string, name: string, directoryKind: string | null) {
  const ts = nowMs();
  const typeId = await ensureTypeAndDefs('nomenclature_template', 'Шаблоны номенклатуры', [
    { code: 'code', name: 'Код', dataType: 'text', sortOrder: 10 },
    { code: 'name', name: 'Название', dataType: 'text', sortOrder: 20 },
    { code: 'item_type_code', name: 'Код типа', dataType: 'text', sortOrder: 30 },
    { code: 'directory_kind', name: 'Источник', dataType: 'text', sortOrder: 40 },
    { code: 'properties_json', name: 'Состав свойств', dataType: 'json', sortOrder: 50 },
  ]);
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)));
  const defByCode = new Map(defs.map((row) => [String(row.code), String(row.id)] as const));
  const rows = await db
    .select({ entityId: entities.id, defId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(entities)
    .leftJoin(attributeValues, and(eq(attributeValues.entityId, entities.id), isNull(attributeValues.deletedAt)))
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)));
  const byEntity = new Map<string, Record<string, string | null>>();
  for (const row of rows) {
    const entityId = String(row.entityId);
    const attrCode = defByCode ? defs.find((d) => String(d.id) === String(row.defId))?.code : null;
    if (!attrCode) continue;
    const bag = byEntity.get(entityId) ?? {};
    bag[String(attrCode)] = row.valueJson ? JSON.parse(String(row.valueJson)) : null;
    byEntity.set(entityId, bag);
  }
  let templateId: string | null = null;
  for (const [entityId, attrs] of byEntity.entries()) {
    if (String(attrs.code ?? '') === code) {
      templateId = entityId;
      break;
    }
  }
  if (!templateId) {
    templateId = randomUUID();
    await db.insert(entities).values({
      id: templateId,
      typeId: typeId as any,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
      lastServerSeq: null,
    });
  }
  const values: Record<string, string | null> = {
    code,
    name,
    item_type_code: null,
    directory_kind: directoryKind,
    properties_json: '[]',
  };
  for (const [attrCode, value] of Object.entries(values)) {
    const defId = defByCode.get(attrCode);
    if (!defId) continue;
    await db
      .insert(attributeValues)
      .values({
        id: randomUUID(),
        entityId: templateId as any,
        attributeDefId: defId as any,
        valueJson: value == null ? null : JSON.stringify(value),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
        lastServerSeq: null,
      })
      .onConflictDoUpdate({
        target: [attributeValues.entityId, attributeValues.attributeDefId],
        set: { valueJson: value == null ? null : JSON.stringify(value), updatedAt: ts, deletedAt: null, syncStatus: 'synced' },
      });
  }
  return templateId;
}

async function main() {
  const templateByKind = new Map<string, string>();
  templateByKind.set('part', await ensureTemplate('legacy_part', 'Legacy детали', 'part'));
  templateByKind.set('tool', await ensureTemplate('legacy_tool', 'Legacy инструменты', 'tool'));
  templateByKind.set('good', await ensureTemplate('legacy_good', 'Legacy товары', 'good'));
  templateByKind.set('service', await ensureTemplate('legacy_service', 'Legacy услуги', 'service'));
  const fallbackTemplateId = await ensureTemplate('legacy_generic', 'Legacy общий', null);

  const rows = await db
    .select({ id: erpNomenclature.id, directoryKind: erpNomenclature.directoryKind, specJson: erpNomenclature.specJson })
    .from(erpNomenclature)
    .where(isNull(erpNomenclature.deletedAt));
  let patched = 0;
  for (const row of rows) {
    const spec = parseObject(row.specJson ?? null);
    if (typeof spec.templateId === 'string' && spec.templateId.trim()) continue;
    const kind = String(row.directoryKind ?? '').trim().toLowerCase();
    const templateId = templateByKind.get(kind) || fallbackTemplateId;
    const next = { ...spec, templateId, propertyValues: spec.propertyValues ?? {} };
    await db.update(erpNomenclature).set({ specJson: JSON.stringify(next), updatedAt: nowMs() }).where(eq(erpNomenclature.id, row.id));
    patched += 1;
  }
  console.log(`[warehouse] governance backfill done: ${patched} rows patched`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[warehouse] governance backfill failed', error);
    process.exit(1);
  });

