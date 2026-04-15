import { and, eq, inArray, isNull } from 'drizzle-orm';

import { computeAssemblyForecast, mergeBrandKits, parseAssemblyIncomingPlanJson } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entityTypes, erpRegStockBalance } from '../database/schema.js';
import { listAllPartEngineBrandLinksForForecast } from './partsService.js';

type ForecastRequest = {
  targetEnginesPerDay: number;
  horizonDays?: number;
  warehouseIds?: string[];
  brandIds?: string[];
  sleeveSearch?: string;
  incomingPlan?: Array<{ dayOffset: number; nomenclatureId: string; qty: number }>;
};

async function getEntityTypeId(code: string): Promise<string | null> {
  const rows = await db.select({ id: entityTypes.id }).from(entityTypes).where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt))).limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function loadNameMap(typeCode: string, entityIds: string[]): Promise<Map<string, { name: string; article: string }>> {
  const out = new Map<string, { name: string; article: string }>();
  const typeId = await getEntityTypeId(typeCode);
  if (!typeId || entityIds.length === 0) return out;

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)));
  const nameDefId = defs.find((d) => String(d.code) === 'name')?.id;
  const articleDefId = defs.find((d) => String(d.code) === 'article')?.id;
  if (!nameDefId) return out;

  const values = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, entityIds as any),
        inArray(attributeValues.attributeDefId, [nameDefId, ...(articleDefId ? [articleDefId] : [])] as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(200_000);

  function parseScalar(raw: string | null): string {
    if (raw == null) return '';
    try {
      const parsed = JSON.parse(String(raw)) as unknown;
      if (parsed == null) return '';
      if (typeof parsed === 'string') return parsed.trim();
      if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
      return '';
    } catch {
      return String(raw).trim();
    }
  }

  for (const row of values as any[]) {
    const id = String(row.entityId);
    const cur = out.get(id) ?? { name: '', article: '' };
    if (String(row.attributeDefId) === String(nameDefId)) cur.name = parseScalar(row.valueJson);
    if (articleDefId && String(row.attributeDefId) === String(articleDefId)) cur.article = parseScalar(row.valueJson);
    out.set(id, cur);
  }
  return out;
}

async function loadNomenclatureStockMap(warehouseIds?: string[]): Promise<Map<string, number>> {
  const rows = await db.select().from(erpRegStockBalance);
  const map = new Map<string, number>();
  for (const row of rows as any[]) {
    const wh = String(row.warehouseId ?? 'default');
    if (warehouseIds?.length && !warehouseIds.includes(wh)) continue;
    const nid = row.nomenclatureId ? String(row.nomenclatureId) : '';
    if (!nid) continue;
    const avail = Math.max(0, Math.floor(Number(row.qty ?? 0) - Number(row.reservedQty ?? 0)));
    map.set(nid, (map.get(nid) ?? 0) + avail);
  }
  return map;
}

export async function computeAssemblyForecastFromServer(args: ForecastRequest) {
  const horizonDays = Math.max(1, Math.min(14, Math.floor(Number(args.horizonDays ?? 7))));
  const targetEnginesPerDay = Math.max(0, Math.floor(Number(args.targetEnginesPerDay ?? 0)));
  const warehouseIds = Array.isArray(args.warehouseIds) ? args.warehouseIds.map(String) : undefined;
  const brandFilter = Array.isArray(args.brandIds) ? new Set(args.brandIds.map(String)) : null;
  const sleeveSearch = String(args.sleeveSearch ?? '');
  const incomingLines = parseAssemblyIncomingPlanJson(args.incomingPlan ?? []);

  const links = await listAllPartEngineBrandLinksForForecast();
  const partIds = Array.from(new Set(links.map((l) => String(l.partId))));
  const brandIds = Array.from(new Set(links.map((l) => String(l.engineBrandId))));
  const partNames = await loadNameMap('part', partIds);
  const brandNames = await loadNameMap('engine_brand', brandIds);

  const compatRows: Array<{
    partId: string;
    brandId: string;
    brandLabel: string;
    partName: string;
    article: string;
    qtyPerEngine: number;
  }> = [];

  for (const link of links) {
    const brandId = String(link.engineBrandId);
    if (brandFilter && !brandFilter.has(brandId)) continue;
    const partId = String(link.partId);
    const qty = Math.max(0, Math.floor(Number(link.quantity ?? 0)));
    if (qty <= 0) continue;
    const pn = partNames.get(partId) ?? { name: '', article: '' };
    compatRows.push({
      partId,
      brandId,
      brandLabel: brandNames.get(brandId)?.name?.trim() || brandId,
      partName: pn.name?.trim() || partId,
      article: pn.article?.trim() ?? '',
      qtyPerEngine: qty,
    });
  }

  const kits = mergeBrandKits(compatRows);
  const stock = await loadNomenclatureStockMap(warehouseIds);

  return computeAssemblyForecast({
    horizonDays,
    targetEnginesPerDay,
    warehouseId: warehouseIds?.length === 1 ? warehouseIds[0]! : null,
    kits,
    stockByNomenclatureId: stock,
    incomingLines,
    sleeveSearch,
  });
}
