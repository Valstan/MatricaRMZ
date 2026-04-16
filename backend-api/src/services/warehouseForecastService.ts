import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { computeAssemblyForecast, type AssemblyComponentRole, type AssemblyEngineBrandKit } from '@matricarmz/shared';

import { db } from '../database/db.js';
import {
  erpEngineAssemblyBom,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpPlannedIncoming,
  erpRegStockBalance,
} from '../database/schema.js';

type ForecastRequest = {
  targetEnginesPerDay: number;
  horizonDays?: number;
  warehouseIds?: string[];
  engineNomenclatureIds?: string[];
};

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

function bomComponentTypeToRole(raw: string): AssemblyComponentRole {
  const value = String(raw).trim().toLowerCase();
  if (value === 'sleeve') return 'sleeve';
  if (value === 'piston') return 'piston';
  if (value === 'ring') return 'rings';
  if (value === 'jacket') return 'jacket';
  if (value === 'head') return 'head';
  return 'other';
}

async function loadActiveDefaultBomKits(engineFilter?: string[]): Promise<AssemblyEngineBrandKit[]> {
  const conditions = [
    eq(erpEngineAssemblyBom.status, 'active'),
    eq(erpEngineAssemblyBom.isDefault, true),
    isNull(erpEngineAssemblyBom.deletedAt),
  ];
  if (engineFilter && engineFilter.length > 0) {
    conditions.push(inArray(erpEngineAssemblyBom.engineNomenclatureId, engineFilter as any));
  }
  const headerRows = await db
    .select()
    .from(erpEngineAssemblyBom)
    .where(and(...conditions));
  if (headerRows.length === 0) return [];
  const bomIds = headerRows.map((row) => String(row.id));
  const engineIds = headerRows.map((row) => String(row.engineNomenclatureId));
  const lineRows = await db
    .select()
    .from(erpEngineAssemblyBomLines)
    .where(and(inArray(erpEngineAssemblyBomLines.bomId, bomIds as any), isNull(erpEngineAssemblyBomLines.deletedAt)));
  const componentIds = Array.from(new Set(lineRows.map((row) => String(row.componentNomenclatureId))));
  const nomenclatureRows =
    componentIds.length + engineIds.length > 0
      ? await db
          .select({ id: erpNomenclature.id, code: erpNomenclature.code, name: erpNomenclature.name })
          .from(erpNomenclature)
          .where(inArray(erpNomenclature.id, Array.from(new Set([...componentIds, ...engineIds])) as any))
      : [];
  const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
  const linesByBom = new Map<string, typeof lineRows>();
  for (const line of lineRows) {
    const bomId = String(line.bomId);
    const arr = linesByBom.get(bomId) ?? [];
    arr.push(line);
    linesByBom.set(bomId, arr);
  }
  return headerRows
    .map((header) => {
      const engineId = String(header.engineNomenclatureId);
      const engineMeta = nomenclatureById.get(engineId);
      const parts = (linesByBom.get(String(header.id)) ?? [])
        .map((line) => {
          const compId = String(line.componentNomenclatureId);
          const compMeta = nomenclatureById.get(compId);
          const qtyPerEngine = Math.max(0, Math.trunc(Number(line.qtyPerUnit ?? 0)));
          if (!compId || qtyPerEngine <= 0) return null;
          const name = compMeta?.name ? String(compMeta.name) : compId;
          const code = compMeta?.code ? String(compMeta.code) : '';
          return {
            partId: compId,
            nomenclatureId: compId,
            qtyPerEngine,
            role: bomComponentTypeToRole(String(line.componentType)),
            partLabel: code ? `${name} (${code})` : name,
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      return {
        brandId: engineId,
        brandLabel: engineMeta?.name ? String(engineMeta.name) : engineId,
        parts,
      };
    })
    .filter((kit) => kit.parts.length > 0);
}

export async function computeAssemblyForecastFromServer(args: ForecastRequest) {
  const horizonDays = Math.max(1, Math.min(14, Math.floor(Number(args.horizonDays ?? 7))));
  const targetEnginesPerDay = Math.max(0, Math.floor(Number(args.targetEnginesPerDay ?? 0)));
  const warehouseIds = Array.isArray(args.warehouseIds) ? args.warehouseIds.map(String) : undefined;
  const engineNomenclatureIds = Array.isArray(args.engineNomenclatureIds) ? args.engineNomenclatureIds.map(String) : undefined;
  const dbIncomingLines = await loadPlannedIncomingLines({
    horizonDays,
    ...(warehouseIds ? { warehouseIds } : {}),
  });
  const kits = await loadActiveDefaultBomKits(engineNomenclatureIds);
  if (kits.length === 0) {
    return {
      rows: [],
      warnings: ['Нет активных default BOM для выбранных двигателей.'],
    };
  }
  const stock = await loadNomenclatureStockMap(warehouseIds);

  return computeAssemblyForecast({
    horizonDays,
    targetEnginesPerDay,
    warehouseId: warehouseIds?.length === 1 ? warehouseIds[0]! : null,
    kits,
    stockByNomenclatureId: stock,
    incomingLines: dbIncomingLines,
  });
}
