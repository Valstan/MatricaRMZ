import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { computeAssemblyForecast, mergeBrandKits, parseAssemblyIncomingPlanJson } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entityTypes, erpPlannedIncoming, erpRegStockBalance } from '../database/schema.js';
import { listAllPartEngineBrandLinksForForecast } from './partsService.js';

type ForecastRequest = {
  targetEnginesPerDay: number;
  horizonDays?: number;
  warehouseIds?: string[];
  brandIds?: string[];
  sleeveNomenclatureId?: string;
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

async function loadPlannedIncomingLines(args: { horizonDays: number; warehouseIds?: string[] }) {
  const now = Date.now();
  const from = now;
  const to = now + args.horizonDays * 24 * 60 * 60 * 1000;
  const rows = await db
    .select()
    .from(erpPlannedIncoming)
    .where(and(isNull(erpPlannedIncoming.deletedAt), sql`${erpPlannedIncoming.expectedDate} >= ${from}`, sql`${erpPlannedIncoming.expectedDate} <= ${to}`));
  const map = new Map<string, number>();
  for (const row of rows as any[]) {
    const wh = String(row.warehouseId ?? 'default');
    if (args.warehouseIds?.length && !args.warehouseIds.includes(wh)) continue;
    const nomenclatureId = String(row.nomenclatureId ?? '').trim();
    if (!nomenclatureId) continue;
    const qty = Math.max(0, Math.floor(Number(row.qty ?? 0)));
    if (!qty) continue;
    const dayOffset = Math.max(0, Math.floor((Number(row.expectedDate ?? now) - now) / (24 * 60 * 60 * 1000)));
    const key = `${dayOffset}::${nomenclatureId}`;
    map.set(key, (map.get(key) ?? 0) + qty);
  }
  return Array.from(map.entries()).map(([key, qty]) => {
    const [offsetRaw, nomenclatureId] = key.split('::');
    return { dayOffset: Math.max(0, Math.min(13, Number(offsetRaw) || 0)), nomenclatureId: String(nomenclatureId), qty };
  });
}

export async function computeAssemblyForecastFromServer(args: ForecastRequest) {
  const horizonDays = Math.max(1, Math.min(14, Math.floor(Number(args.horizonDays ?? 7))));
  const targetEnginesPerDay = Math.max(0, Math.floor(Number(args.targetEnginesPerDay ?? 0)));
  const warehouseIds = Array.isArray(args.warehouseIds) ? args.warehouseIds.map(String) : undefined;
  const brandFilter = Array.isArray(args.brandIds) ? new Set(args.brandIds.map(String)) : null;
  const sleeveNomenclatureId = String(args.sleeveNomenclatureId ?? '').trim();
  const sleeveSearch = String(args.sleeveSearch ?? '');
  const incomingLines = parseAssemblyIncomingPlanJson(args.incomingPlan ?? []);
  const dbIncomingLines = await loadPlannedIncomingLines({
    horizonDays,
    ...(warehouseIds ? { warehouseIds } : {}),
  });
  const mergedIncomingMap = new Map<string, number>();
  for (const line of [...dbIncomingLines, ...incomingLines]) {
    const key = `${line.dayOffset}::${line.nomenclatureId}`;
    mergedIncomingMap.set(key, (mergedIncomingMap.get(key) ?? 0) + Math.max(0, Math.floor(Number(line.qty ?? 0))));
  }
  const mergedIncomingLines = Array.from(mergedIncomingMap.entries())
    .map(([key, qty]) => {
      const [dayOffsetRaw, nomenclatureIdRaw] = key.split('::');
      const nomenclatureId = String(nomenclatureIdRaw ?? '').trim();
      if (!nomenclatureId) return null;
      return { dayOffset: Number(dayOffsetRaw) || 0, nomenclatureId, qty };
    })
    .filter((line): line is { dayOffset: number; nomenclatureId: string; qty: number } => Boolean(line));

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
    incomingLines: mergedIncomingLines,
    ...(sleeveNomenclatureId ? { sleeveNomenclatureId } : {}),
    sleeveSearch,
  });
}
