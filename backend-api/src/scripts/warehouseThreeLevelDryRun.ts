import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  erpEngineInstances,
  erpNomenclature,
  erpNomenclatureEngineBrand,
} from '../database/schema.js';

type EngineAttrs = {
  engineNumber: string | null;
  engineBrandId: string | null;
  contractId: string | null;
};

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function normalizeItemTypeToCategory(itemType: string): 'engine' | 'component' | 'assembly' {
  const t = String(itemType || '').toLowerCase();
  if (t === 'engine') return 'engine';
  if (t === 'product' || t === 'semi_product' || t === 'assembly') return 'assembly';
  return 'component';
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pickText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseJsonScalar(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (parsed == null) return null;
    if (typeof parsed === 'string') return pickText(parsed);
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
    return null;
  } catch {
    return pickText(raw);
  }
}

async function main() {
  const apply = hasFlag('--apply');
  const asJson = hasFlag('--json');
  const ts = Date.now();

  const allNomenclature = await db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt)).limit(200_000);
  const updates: Array<{
    id: string;
    sku: string;
    category: 'engine' | 'component' | 'assembly';
    isSerialTracked: boolean;
    defaultBrandId: string | null;
  }> = [];
  const skuSeen = new Map<string, string>();
  const skuDuplicates: Array<{ sku: string; id: string; clashWith: string }> = [];
  const partNomenclatureByPartId = new Map<string, string[]>();
  const engineNomenclatureByBrandId = new Map<string, string[]>();
  const nomenclatureById = new Map(allNomenclature.map((row) => [String(row.id), row]));

  for (const row of allNomenclature) {
    const id = String(row.id);
    const spec = parseJsonObject(row.specJson);
    const partId = pickText(spec.partId);
    if (partId) {
      const list = partNomenclatureByPartId.get(partId) ?? [];
      list.push(id);
      partNomenclatureByPartId.set(partId, list);
    }

    const inferredBrandId =
      pickText((row as Record<string, unknown>).defaultBrandId) ??
      pickText(spec.defaultBrandId) ??
      pickText(spec.engineBrandId) ??
      null;
    if (String(row.itemType ?? '').toLowerCase() === 'engine' && inferredBrandId) {
      const list = engineNomenclatureByBrandId.get(inferredBrandId) ?? [];
      list.push(id);
      engineNomenclatureByBrandId.set(inferredBrandId, list);
    }

    const sku = String(row.sku ?? row.code ?? '').trim() || `NM-${id.slice(0, 8)}`;
    const first = skuSeen.get(sku);
    if (first && first !== id) {
      skuDuplicates.push({ sku, id, clashWith: first });
    } else {
      skuSeen.set(sku, id);
    }

    updates.push({
      id,
      sku,
      category: normalizeItemTypeToCategory(String(row.itemType ?? '')),
      isSerialTracked: String(row.itemType ?? '').toLowerCase() === 'engine',
      defaultBrandId: inferredBrandId,
    });
  }

  const pebType = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'part_engine_brand'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const compatCandidates = new Map<string, { nomenclatureId: string; engineBrandId: string; isDefault: boolean }>();
  if (pebType[0]?.id) {
    const pebTypeId = String(pebType[0].id);
    const defs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, pebTypeId), isNull(attributeDefs.deletedAt)));
    const partIdDef = defs.find((d) => d.code === 'part_id')?.id;
    const brandIdDef = defs.find((d) => d.code === 'engine_brand_id')?.id;
    if (partIdDef && brandIdDef) {
      const linkRows = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.typeId, pebTypeId), isNull(entities.deletedAt)))
        .limit(200_000);
      const linkIds = linkRows.map((r) => String(r.id));
      if (linkIds.length > 0) {
        const values = await db
          .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(
            and(
              inArray(attributeValues.entityId, linkIds as any),
              inArray(attributeValues.attributeDefId, [partIdDef, brandIdDef] as any),
              isNull(attributeValues.deletedAt),
            ),
          )
          .limit(500_000);
        const byLink = new Map<string, { partId: string | null; engineBrandId: string | null }>();
        for (const row of values) {
          const linkId = String(row.entityId);
          const cur = byLink.get(linkId) ?? { partId: null, engineBrandId: null };
          const raw = parseJsonScalar(row.valueJson);
          if (String(row.attributeDefId) === String(partIdDef)) cur.partId = raw;
          if (String(row.attributeDefId) === String(brandIdDef)) cur.engineBrandId = raw;
          byLink.set(linkId, cur);
        }
        for (const row of byLink.values()) {
          if (!row.partId || !row.engineBrandId) continue;
          const nomenclatureIds = partNomenclatureByPartId.get(row.partId) ?? [];
          for (const nomenclatureId of nomenclatureIds) {
            const key = `${nomenclatureId}|${row.engineBrandId}`;
            compatCandidates.set(key, { nomenclatureId, engineBrandId: row.engineBrandId, isDefault: false });
          }
        }
      }
    }
  }

  for (const upd of updates) {
    if (!upd.defaultBrandId) continue;
    const key = `${upd.id}|${upd.defaultBrandId}`;
    compatCandidates.set(key, { nomenclatureId: upd.id, engineBrandId: upd.defaultBrandId, isDefault: true });
  }

  const engineType = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'engine'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const instanceCandidates: Array<{ nomenclatureId: string; serialNumber: string; contractId: string | null; warehouseId: string; currentStatus: string }> = [];
  const unresolvedEngines: string[] = [];
  if (engineType[0]?.id) {
    const engineTypeId = String(engineType[0].id);
    const defs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, engineTypeId), isNull(attributeDefs.deletedAt)));
    const numberDef = defs.find((d) => d.code === 'engine_number')?.id;
    const brandDef = defs.find((d) => d.code === 'engine_brand_id')?.id;
    const contractDef = defs.find((d) => d.code === 'contract_id')?.id;
    const engineRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.typeId, engineTypeId), isNull(entities.deletedAt)))
      .limit(200_000);
    const engineIds = engineRows.map((r) => String(r.id));
    const defIds = [numberDef, brandDef, contractDef].filter(Boolean) as string[];
    if (engineIds.length > 0 && defIds.length > 0) {
      const values = await db
        .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
        .from(attributeValues)
        .where(
          and(
            inArray(attributeValues.entityId, engineIds as any),
            inArray(attributeValues.attributeDefId, defIds as any),
            isNull(attributeValues.deletedAt),
          ),
        )
        .limit(800_000);
      const byEngine = new Map<string, EngineAttrs>();
      for (const row of values) {
        const engineId = String(row.entityId);
        const cur = byEngine.get(engineId) ?? { engineNumber: null, engineBrandId: null, contractId: null };
        const raw = parseJsonScalar(row.valueJson);
        if (String(row.attributeDefId) === String(numberDef)) cur.engineNumber = raw;
        if (String(row.attributeDefId) === String(brandDef)) cur.engineBrandId = raw;
        if (String(row.attributeDefId) === String(contractDef)) cur.contractId = raw;
        byEngine.set(engineId, cur);
      }
      for (const [engineId, attrs] of byEngine.entries()) {
        if (!attrs.engineNumber || !attrs.engineBrandId) continue;
        const nomenclatureIds = engineNomenclatureByBrandId.get(attrs.engineBrandId) ?? [];
        if (!nomenclatureIds.length) {
          unresolvedEngines.push(engineId);
          continue;
        }
        const nomenclatureId = nomenclatureIds[0];
        if (!nomenclatureId) continue;
        instanceCandidates.push({
          nomenclatureId,
          serialNumber: attrs.engineNumber,
          contractId: attrs.contractId,
          warehouseId: 'default',
          currentStatus: 'in_stock',
        });
      }
    }
  }

  const instanceConflicts: Array<{ nomenclatureId: string; serialNumber: string }> = [];
  const seenInstance = new Set<string>();
  for (const row of instanceCandidates) {
    const key = `${row.nomenclatureId}|${row.serialNumber}`;
    if (seenInstance.has(key)) instanceConflicts.push({ nomenclatureId: row.nomenclatureId, serialNumber: row.serialNumber });
    seenInstance.add(key);
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    nomenclatureRows: allNomenclature.length,
    nomenclatureUpdatesPlanned: updates.length,
    compatibilityRowsPlanned: compatCandidates.size,
    engineInstancesPlanned: instanceCandidates.length,
    unresolvedEngines: unresolvedEngines.length,
    skuConflicts: skuDuplicates.length,
    serialConflicts: instanceConflicts.length,
    canApply: skuDuplicates.length === 0 && instanceConflicts.length === 0,
  };

  if (!apply) {
    if (asJson) {
      console.log(JSON.stringify({ report, skuDuplicates, instanceConflicts, unresolvedEngines: unresolvedEngines.slice(0, 200) }, null, 2));
    } else {
      console.log('[warehouse-3level] dry-run report');
      console.log(report);
      if (skuDuplicates.length) console.log('SKU conflicts:', skuDuplicates.slice(0, 20));
      if (instanceConflicts.length) console.log('Serial conflicts:', instanceConflicts.slice(0, 20));
      if (unresolvedEngines.length) console.log('Unresolved engines:', unresolvedEngines.slice(0, 20));
    }
    return;
  }

  if (!report.canApply) {
    throw new Error('Dry-run conflicts detected. Resolve conflicts before --apply.');
  }

  await db.transaction(async (tx) => {
    for (const upd of updates) {
      const current = nomenclatureById.get(upd.id);
      if (!current) continue;
      await tx
        .update(erpNomenclature)
        .set({
          sku: current.sku ?? upd.sku,
          category: (current as Record<string, unknown>).category ? String((current as Record<string, unknown>).category) : upd.category,
          defaultBrandId: (current as Record<string, unknown>).defaultBrandId ? String((current as Record<string, unknown>).defaultBrandId) : upd.defaultBrandId,
          isSerialTracked: Boolean((current as Record<string, unknown>).isSerialTracked ?? upd.isSerialTracked),
          updatedAt: ts,
        } as any)
        .where(eq(erpNomenclature.id, upd.id));
    }

    for (const row of compatCandidates.values()) {
      const exists = await tx
        .select({ id: erpNomenclatureEngineBrand.id })
        .from(erpNomenclatureEngineBrand)
        .where(
          and(
            eq(erpNomenclatureEngineBrand.nomenclatureId, row.nomenclatureId),
            eq(erpNomenclatureEngineBrand.engineBrandId, row.engineBrandId),
            isNull(erpNomenclatureEngineBrand.deletedAt),
          ),
        )
        .limit(1);
      if (exists[0]?.id) continue;
      await tx.insert(erpNomenclatureEngineBrand).values({
        id: randomUUID(),
        nomenclatureId: row.nomenclatureId,
        engineBrandId: row.engineBrandId,
        isDefault: row.isDefault,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
        lastServerSeq: null,
      } as any);
    }

    for (const row of instanceCandidates) {
      const exists = await tx
        .select({ id: erpEngineInstances.id })
        .from(erpEngineInstances)
        .where(
          and(
            eq(erpEngineInstances.nomenclatureId, row.nomenclatureId),
            eq(erpEngineInstances.serialNumber, row.serialNumber),
            isNull(erpEngineInstances.deletedAt),
          ),
        )
        .limit(1);
      if (exists[0]?.id) continue;
      await tx.insert(erpEngineInstances).values({
        id: randomUUID(),
        nomenclatureId: row.nomenclatureId,
        serialNumber: row.serialNumber,
        contractId: row.contractId,
        currentStatus: row.currentStatus,
        warehouseId: row.warehouseId,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
        lastServerSeq: null,
      } as any);
    }
  });

  console.log(JSON.stringify({ report, applied: true }, null, 2));
}

main()
  .catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
