import { createHash, randomUUID } from 'node:crypto';

import type { AssemblyPlanCandidate, AssemblyPlanResolution, AssemblyExecutionProfile } from '@matricarmz/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  warehouseLocations,
} from '../database/schema.js';
import { getWarehouseAssemblyBom } from './warehouseBomService.js';

function parseJsonString(value: string | null): string {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return '';
  }
}

export function computeAssemblyMaterialHash(args: {
  engineId: string;
  engineBrandId: string;
  bomId: string;
  version: number;
  variantKey: string | null;
  materials: Array<{ nomenclatureId: string; qty: number; sourceWarehouseId: string }>;
}): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

async function resolveEngineBrandId(engineId: string): Promise<{ exists: boolean; brandId: string }> {
  const rows = await db
    .select({ attrCode: attributeDefs.code, valueJson: attributeValues.valueJson })
    .from(entities)
    .innerJoin(entityTypes, and(eq(entityTypes.id, entities.typeId), eq(entityTypes.code, 'engine')))
    .leftJoin(attributeDefs, and(eq(attributeDefs.entityTypeId, entityTypes.id), eq(attributeDefs.code, 'engine_brand_id')))
    .leftJoin(
      attributeValues,
      and(eq(attributeValues.entityId, entities.id), eq(attributeValues.attributeDefId, attributeDefs.id), isNull(attributeValues.deletedAt)),
    )
    .where(and(eq(entities.id, engineId as any), isNull(entities.deletedAt)))
    .limit(1);
  if (rows.length === 0) return { exists: false, brandId: '' };
  return { exists: true, brandId: parseJsonString(rows[0]?.valueJson ?? null) };
}

async function loadCandidates(engineBrandId: string): Promise<Array<AssemblyPlanCandidate & { isDefaultForBrand: boolean }>> {
  const rows = await db
    .select({
      bomId: erpEngineAssemblyBom.id,
      bomName: erpEngineAssemblyBom.name,
      version: erpEngineAssemblyBom.version,
      defaultVariantKey: erpEngineAssemblyBom.defaultVariantKey,
      isDefaultForBrand: erpEngineAssemblyBomBrandLinks.isDefaultForBrand,
    })
    .from(erpEngineAssemblyBom)
    .innerJoin(
      erpEngineAssemblyBomBrandLinks,
      and(
        eq(erpEngineAssemblyBomBrandLinks.bomId, erpEngineAssemblyBom.id),
        eq(erpEngineAssemblyBomBrandLinks.engineBrandId, engineBrandId as any),
        isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
      ),
    )
    .where(and(eq(erpEngineAssemblyBom.status, 'active'), isNull(erpEngineAssemblyBom.deletedAt)))
    .orderBy(asc(erpEngineAssemblyBom.name));
  return rows.map((row) => ({
    bomId: String(row.bomId),
    bomName: String(row.bomName),
    version: Number(row.version),
    defaultVariantKey: row.defaultVariantKey,
    isDefaultForBrand: Boolean(row.isDefaultForBrand),
  }));
}

export async function resolveAssemblyPlan(args: { engineId: string; bomId?: string }): Promise<AssemblyPlanResolution> {
  try {
    const engineId = args.engineId.trim();
    const engine = await resolveEngineBrandId(engineId);
    if (!engine.exists) return { ok: false, code: 'engine_not_found', error: 'Двигатель не найден' };
    if (!engine.brandId) return { ok: false, code: 'engine_brand_missing', error: 'В карточке двигателя не выбрана марка' };
    const candidates = await loadCandidates(engine.brandId);
    if (candidates.length === 0) {
      return { ok: false, code: 'bom_missing', error: 'Для марки двигателя не настроена активная BOM', engineBrandId: engine.brandId };
    }
    const selected = args.bomId
      ? candidates.find((candidate) => candidate.bomId === args.bomId)
      : (() => {
          const defaults = candidates.filter((candidate) => candidate.isDefaultForBrand);
          return defaults.length === 1 ? defaults[0] : null;
        })();
    if (!selected) {
      return {
        ok: false,
        code: 'bom_conflict',
        error: 'Для марки не выбран единственный основной BOM — выберите спецификацию вручную',
        engineBrandId: engine.brandId,
        candidates: candidates.map(({ isDefaultForBrand: _ignored, ...candidate }) => candidate),
      };
    }
    const details = await getWarehouseAssemblyBom({ id: selected.bomId });
    if (!details.ok) return { ok: false, code: 'bom_missing', error: details.error, engineBrandId: engine.brandId };
    const header = details.bom.header;
    const allLines = details.bom.lines;
    const variantKey = typeof header.defaultVariantKey === 'string' && header.defaultVariantKey.trim()
      ? header.defaultVariantKey.trim()
      : null;
    const lines = allLines.filter((line) => {
      const lineVariant = typeof line.variantGroup === 'string' && line.variantGroup.trim() ? line.variantGroup.trim() : null;
      return lineVariant === variantKey;
    });
    if (lines.length === 0) {
      return { ok: false, code: 'variant_missing', error: 'В основном варианте BOM нет материалов', engineBrandId: engine.brandId };
    }
    const profile = header.executionProfile && typeof header.executionProfile === 'object'
      ? (header.executionProfile as AssemblyExecutionProfile)
      : null;
    if (!profile) {
      return { ok: false, code: 'profile_missing', error: 'Для BOM не настроен профиль выполнения сборки', engineBrandId: engine.brandId };
    }
    const workshopWarehouse = profile.workshopId
      ? await db
          .select({ id: warehouseLocations.id })
          .from(warehouseLocations)
          .where(and(eq(warehouseLocations.workshopId, profile.workshopId as any), isNull(warehouseLocations.deletedAt)))
          .limit(1)
      : [];
    const sourceWarehouseId = workshopWarehouse[0]?.id ? String(workshopWarehouse[0].id) : 'default';
    const capturedAt = Date.now();
    const operationId = randomUUID();
    const materials = lines.map((line, index) => ({
      lineNo: index + 1,
      nomenclatureId: String(line.componentNomenclatureId),
      nomenclatureName: String(line.componentNomenclatureName ?? ''),
      nomenclatureCode: String(line.componentNomenclatureCode ?? ''),
      qty: Number(line.qtyPerUnit ?? 1),
      sourceWarehouseId,
    }));
    const works = profile.works.map((work, index) => ({
      lineNo: index + 1,
      serviceId: work.serviceId,
      serviceName: work.serviceName,
      unit: work.unit,
      qty: work.qty,
      priceRub: work.priceRub,
      amountRub: Math.round(work.qty * work.priceRub * 100) / 100,
      engineId,
      engineBrandId: engine.brandId,
      partId: null,
    }));
    const materialHash = computeAssemblyMaterialHash({
      engineId,
      engineBrandId: engine.brandId,
      bomId: selected.bomId,
      version: selected.version,
      variantKey,
      materials: materials.map((line) => ({
        nomenclatureId: line.nomenclatureId,
        qty: line.qty,
        sourceWarehouseId: line.sourceWarehouseId,
      })),
    });
    return {
      ok: true,
      engineId,
      engineBrandId: engine.brandId,
      materialHash,
      snapshot: {
        engineBrandId: engine.brandId,
        bomId: selected.bomId,
        bomName: selected.bomName,
        bomVersion: selected.version,
        variantKey,
        profileVersion: profile.version,
        capturedAt,
        operationId,
        materials,
        works,
        executionProfile: profile,
      },
    };
  } catch (error) {
    return { ok: false, code: 'bom_missing', error: String(error) };
  }
}
