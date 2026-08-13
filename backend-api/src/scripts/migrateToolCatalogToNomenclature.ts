import 'dotenv/config';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, directoryTools, entities, entityTypes, erpNomenclature } from '../database/schema.js';
import { upsertWarehouseNomenclature } from '../services/warehouseService.js';

// Ф2 плана tools-catalog-unify-2026-08-13 (вариант A, решение владельца 2026-08-13).
//
// Что чинится. Инструмент — единственный вид справочника, у которого цепочка «карточка-источник →
// erp_nomenclature» собрана НЕ из наименований, а из экземпляров: миграция 0045 набила
// directory_tools строками EAV-типа `tool` (конкретные единицы с серийниками), и оттуда они уехали
// в номенклатуру как «позиции». Настоящий справочник наименований (`tool_catalog`) в номенклатуру
// не переносился вовсе. У деталей/товаров/услуг цепочка правильная: имя → directory_* → номенклатура.
//
// Что делает скрипт — приводит инструмент к общей схеме:
//   tool_catalog (наименование) → directory_tools → erp_nomenclature (позиция)
// Существующие TL-строки НЕ дублируются: они переиспользуются под то же имя, у них лишь
// переставляется directory_ref_id на карточку наименования и вычищаются ЭКЗЕМПЛЯРНЫЕ поля из
// spec_json (tool_number / serial_number / department_id / received_at / tool_catalog_id и мусор
// "[object Object]", оставшийся от строкового приведения при прошлом переносе). Эти данные живут
// в EAV-экземпляре и там целы — здесь они просто лишние.
// Наименованиям без позиции (напр. «Молоток») позиция создаётся.
//
// Экземпляры не трогаются: связь «экземпляр → наименование» уже есть в атрибуте tool_catalog_id,
// и после этого прогона она доходит до номенклатуры через directory_ref_id.
//
// Запись — через upsertWarehouseNomenclature (PG + подпись в ledger, откуда тянут клиенты).
// Прямой UPDATE подписал бы PG мимо ledger, и клиенты остались бы со старой строкой.
//
// Запуск:
//   pnpm -F @matricarmz/backend-api warehouse:migrate-tool-catalog
//   pnpm -F @matricarmz/backend-api warehouse:migrate-tool-catalog -- --apply

const TOOL_CATALOG_TYPE = 'tool_catalog';
const INSTANCE_ONLY_SPEC_KEYS = new Set([
  'tool_number',
  'serial_number',
  'department_id',
  'received_at',
  'retired_at',
  'retire_reason',
  'tool_catalog_id',
  'properties',
  'photos',
  'description',
]);

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function nameKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replaceAll('ё', 'е').replaceAll(/\s+/g, ' ');
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** Наименования инструмента из EAV `tool_catalog`. */
async function loadToolCatalog(): Promise<Array<{ id: string; name: string; createdAt: number }>> {
  const typeRows = await db.select({ id: entityTypes.id }).from(entityTypes).where(eq(entityTypes.code, TOOL_CATALOG_TYPE)).limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : null;
  if (!typeId) return [];

  const rows = await db
    .select({ id: entities.id, createdAt: entities.createdAt })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
    .limit(20_000);
  if (rows.length === 0) return [];

  const defRows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
    .limit(1);
  const nameDefId = defRows[0]?.id ? String(defRows[0].id) : null;
  if (!nameDefId) return [];

  const values = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, rows.map((r) => String(r.id))),
        eq(attributeValues.attributeDefId, nameDefId as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(50_000);

  const nameById = new Map<string, string>();
  for (const v of values) {
    const parsed = parseJson(v.valueJson);
    if (typeof parsed === 'string' && parsed.trim()) nameById.set(String(v.entityId), parsed.trim());
  }

  return rows
    .map((r) => ({ id: String(r.id), name: nameById.get(String(r.id)) ?? '', createdAt: Number(r.createdAt ?? 0) }))
    .filter((r) => r.name)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** spec_json без экземплярных полей; возвращает null, если чистить нечего. */
function cleanSpecJson(raw: string | null): { next: string | null; removed: string[] } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const spec = parsed as { templateId?: unknown; propertyValues?: unknown };
  const values = spec.propertyValues;
  if (!values || typeof values !== 'object') return null;
  const removed: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (INSTANCE_ONLY_SPEC_KEYS.has(key) || value === '[object Object]') removed.push(key);
    else kept[key] = value;
  }
  if (removed.length === 0) return null;
  return { next: JSON.stringify({ ...spec, propertyValues: kept }), removed };
}

async function main() {
  const apply = hasFlag('--apply');
  console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const catalog = await loadToolCatalog();
  console.log(`наименований в tool_catalog: ${catalog.length}`);
  if (catalog.length === 0) {
    console.log('Справочник наименований пуст — переносить нечего.');
    return;
  }

  const positions = await db
    .select()
    .from(erpNomenclature)
    .where(and(eq(erpNomenclature.directoryKind, 'tool'), isNull(erpNomenclature.deletedAt)))
    .limit(20_000);
  console.log(`позиций номенклатуры с источником «инструмент»: ${positions.length}`);

  const takenPositionIds = new Set<string>();
  const positionByName = new Map<string, typeof positions>();
  for (const row of positions) {
    const key = nameKey(row.name);
    const bucket = positionByName.get(key);
    if (bucket) bucket.push(row);
    else positionByName.set(key, [row]);
  }

  // Группа/единица/шаблон для НОВЫХ позиций — берём с уже существующей позиции инструмента,
  // чтобы «Молоток» лёг ровно туда же, где лежат остальные, без угадывания названий групп.
  const sample = positions.find((r) => r.groupId && r.unitId) ?? null;
  const sampleSpec = sample ? (parseJson(sample.specJson) as { templateId?: unknown } | null) : null;
  const templateId = sampleSpec?.templateId ? String(sampleSpec.templateId) : null;

  const plannedUpdates: Array<{ positionId: string; code: string; name: string; refId: string; removedSpecKeys: string[] }> = [];
  const plannedCreates: Array<{ name: string; refId: string }> = [];
  const problems: string[] = [];

  for (const item of catalog) {
    const bucket = positionByName.get(nameKey(item.name)) ?? [];
    const free = bucket.find((row) => !takenPositionIds.has(String(row.id)));
    if (free) {
      takenPositionIds.add(String(free.id));
      const cleaned = cleanSpecJson(free.specJson ?? null);
      plannedUpdates.push({
        positionId: String(free.id),
        code: String(free.code ?? ''),
        name: String(free.name ?? ''),
        refId: item.id,
        removedSpecKeys: cleaned?.removed ?? [],
      });
      continue;
    }
    if (!sample || !templateId) {
      problems.push(`«${item.name}»: нет образцовой позиции инструмента (группа/единица/шаблон) — создать нечем`);
      continue;
    }
    plannedCreates.push({ name: item.name, refId: item.id });
  }

  const orphanPositions = positions.filter((row) => !takenPositionIds.has(String(row.id)));

  console.log(`\nпереиспользовать существующих позиций: ${plannedUpdates.length}`);
  for (const u of plannedUpdates) {
    const spec = u.removedSpecKeys.length ? `, вычистить из spec_json: ${u.removedSpecKeys.join(', ')}` : '';
    console.log(`  ↻ ${u.code || '(без кода)'} «${u.name}» → источник ${u.refId}${spec}`);
  }
  console.log(`создать новых позиций: ${plannedCreates.length}`);
  for (const c of plannedCreates) console.log(`  + «${c.name}» → источник ${c.refId}`);
  console.log(`позиций без наименования в справочнике: ${orphanPositions.length}`);
  for (const o of orphanPositions) console.log(`  ? ${o.code || '(без кода)'} «${o.name}» — в tool_catalog такого имени нет`);
  for (const p of problems) console.log(`  ! ${p}`);

  if (!apply) {
    console.log('\nDRY-RUN: ничего не записано. Повторить с --apply.');
    return;
  }

  const ts = Date.now();
  let written = 0;
  const failures: string[] = [];

  // Зеркало directory_tools для наименований — иначе upsert не резолвит источник.
  for (const item of catalog) {
    await db
      .insert(directoryTools)
      .values({
        id: item.id,
        name: item.name,
        isActive: true,
        metadataJson: null,
        deprecatedAt: null,
        createdAt: item.createdAt || ts,
        updatedAt: ts,
        deletedAt: null,
      })
      .onConflictDoUpdate({ target: directoryTools.id, set: { name: item.name, isActive: true, deletedAt: null, updatedAt: ts } });
  }

  for (const plan of plannedUpdates) {
    const rows = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, plan.positionId as any)).limit(1);
    const current = rows[0];
    if (!current) {
      failures.push(`${plan.positionId}: строка исчезла между чтением и записью`);
      continue;
    }
    const cleaned = cleanSpecJson(current.specJson ?? null);
    const result = await upsertWarehouseNomenclature({
      id: plan.positionId,
      code: String(current.code ?? ''),
      sku: current.sku ?? null,
      name: String(current.name ?? ''),
      itemType: String(current.itemType ?? 'tool'),
      category: current.category ?? null,
      directoryKind: 'tool',
      directoryRefId: plan.refId,
      groupId: current.groupId ? String(current.groupId) : null,
      unitId: current.unitId ? String(current.unitId) : null,
      barcode: current.barcode ?? null,
      minStock: current.minStock ?? null,
      maxStock: current.maxStock ?? null,
      defaultBrandId: current.defaultBrandId ? String(current.defaultBrandId) : null,
      isSerialTracked: current.isSerialTracked === true,
      defaultWarehouseId: current.defaultWarehouseId ?? null,
      specJson: cleaned ? cleaned.next : current.specJson ?? null,
      componentTypeId: current.componentTypeId ?? null,
      isActive: current.isActive !== false,
    });
    if (!result.ok) {
      failures.push(`${plan.positionId} «${plan.name}»: ${String(result.error)}`);
      continue;
    }
    written += 1;
  }

  for (const plan of plannedCreates) {
    const result = await upsertWarehouseNomenclature({
      code: '',
      name: plan.name,
      itemType: 'tool',
      category: sample?.category ?? 'component',
      directoryKind: 'tool',
      directoryRefId: plan.refId,
      groupId: sample?.groupId ? String(sample.groupId) : null,
      unitId: sample?.unitId ? String(sample.unitId) : null,
      specJson: JSON.stringify({ templateId, propertyValues: {} }),
      isActive: true,
    });
    if (!result.ok) {
      failures.push(`создание «${plan.name}»: ${String(result.error)}`);
      continue;
    }
    written += 1;
  }

  console.log(`\nзаписано: ${written} из ${plannedUpdates.length + plannedCreates.length}`);
  for (const f of failures) console.log(`  ! ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
