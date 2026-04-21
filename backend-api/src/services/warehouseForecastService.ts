import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  computeAssemblyForecast,
  EntityTypeCode,
  type AssemblyComponentRole,
  type AssemblyEngineBrandKit,
  type AssemblyWarehouseStockBin,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { listWarehouseLookups } from './warehouseService.js';
import {
  attributeDefs,
  attributeValues,
  entityTypes,
  erpEngineAssemblyBom,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpPlannedIncoming,
  erpRegStockBalance,
} from '../database/schema.js';
import { parseWarehouseBomLineMeta } from './warehouseBomLineMeta.js';

type ForecastRequest = {
  targetEnginesPerDay: number;
  sameBrandBatchSize?: number;
  horizonDays?: number;
  warehouseIds?: string[];
  /** Фильтр по маркам двигателя из справочника (entities). */
  engineBrandIds?: string[];
  /** Марки, которые в прогнозе обрабатываются первыми (round-robin внутри группы), затем остальные. */
  priorityEngineBrandIds?: string[];
  /** Рабочие дни недели (0=вс, 1=пн ... 6=сб). */
  workingWeekdays?: number[];
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

async function loadWarehouseIdToLabelMap(): Promise<Map<string, string>> {
  try {
    const res = await listWarehouseLookups();
    if (!res.ok) return new Map([['default', 'Основной склад']]);
    const m = new Map<string, string>();
    for (const w of res.lookups.warehouses) {
      const id = String(w.id ?? '').trim();
      if (!id) continue;
      let lab = String(w.label ?? '').trim();
      if (!lab || isUuidLike(lab)) lab = id === 'default' ? 'Основной склад' : 'Склад';
      m.set(id, lab);
    }
    if (!m.has('default')) m.set('default', 'Основной склад');
    return m;
  } catch {
    return new Map([['default', 'Основной склад']]);
  }
}

async function loadNomenclatureWarehouseBins(
  warehouseIds: string[] | undefined,
  warehouseLabels: Map<string, string>,
): Promise<Map<string, AssemblyWarehouseStockBin[]>> {
  const rows = await db.select().from(erpRegStockBalance);
  const detail = new Map<string, AssemblyWarehouseStockBin[]>();
  for (const row of rows as any[]) {
    const wh = String(row.warehouseId ?? 'default');
    if (warehouseIds?.length && !warehouseIds.includes(wh)) continue;
    const nid = row.nomenclatureId ? String(row.nomenclatureId) : '';
    if (!nid) continue;
    const avail = Math.max(0, Math.floor(Number(row.qty ?? 0) - Number(row.reservedQty ?? 0)));
    if (avail <= 0) continue;
    let label = warehouseLabels.get(wh) ?? '';
    if (!label.trim() || isUuidLike(label)) {
      label = wh === 'default' ? 'Основной склад' : 'Склад';
    }
    const arr = detail.get(nid) ?? [];
    arr.push({ warehouseId: wh, warehouseLabel: label, qty: avail });
    detail.set(nid, arr);
  }
  return detail;
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
    return { dayOffset: Math.max(0, Math.min(30, Number(offsetRaw) || 0)), nomenclatureId: String(nomenclatureId), qty };
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

function safeJsonText(raw: string): string {
  try {
    const v = JSON.parse(raw);
    if (v == null) return '';
    return String(v);
  } catch {
    return raw;
  }
}

/** UUID v4 — в подписях отчёта оператору не показываем. */
function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s).trim());
}

function displayEngineBrandTitle(engineBrandId: string, resolvedTitle: string): string {
  const t = String(resolvedTitle ?? '').trim();
  if (t && !isUuidLike(t)) return t;
  return isUuidLike(engineBrandId) ? 'Марка двигателя (без названия)' : t || engineBrandId;
}

/** Подпись комплектующей в прогнозе: без сырого id номенклатуры, если в БД нет человекочитаемого имени. */
function partLabelForAssemblyForecast(
  compMeta: { name?: string | null; code?: string | null } | undefined,
  compId: string,
): string {
  const nameRaw = compMeta?.name != null ? String(compMeta.name).trim() : '';
  const codeRaw = compMeta?.code != null ? String(compMeta.code).trim() : '';
  const name =
    nameRaw && !isUuidLike(nameRaw)
      ? nameRaw
      : isUuidLike(compId)
        ? 'Позиция без названия'
        : nameRaw
          ? 'Позиция без названия'
          : String(compId);
  if (codeRaw && !isUuidLike(codeRaw)) return `${name} (${codeRaw})`;
  return name;
}

/** Внутренние ключи варианта BOM `__kit_*` в отчёте не показываем — только порядковый вариант при нескольких. */
function assemblyForecastBrandLabelForVariant(
  brandTitle: string,
  groupKey: string | null,
  technicalGroupKeys: string[],
): string {
  if (!groupKey) return brandTitle;
  const gk = String(groupKey);
  if (gk.startsWith('__kit_')) {
    if (technicalGroupKeys.length <= 1) return brandTitle;
    const idx = technicalGroupKeys.indexOf(gk);
    const n = idx >= 0 ? idx + 1 : 1;
    return `${brandTitle} (вариант ${n})`;
  }
  return `${brandTitle} [${gk}]`;
}

async function loadEngineBrandDisplayNames(brandIds: string[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(brandIds.map((id) => String(id).trim()).filter(Boolean)));
  const fallback = new Map<string, string>();
  for (const id of ids) fallback.set(id, id);
  if (ids.length === 0) return fallback;

  const typeRow = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, EntityTypeCode.EngineBrand), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRow[0]?.id ? String(typeRow[0].id) : '';
  if (!typeId) return fallback;

  const defRow = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
    .limit(1);
  const nameDefId = defRow[0]?.id ? String(defRow[0].id) : '';
  if (!nameDefId) return fallback;

  const vals = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, ids as any), eq(attributeValues.attributeDefId, nameDefId as any), isNull(attributeValues.deletedAt)));

  const out = new Map(fallback);
  for (const row of vals) {
    const label = safeJsonText(row.valueJson == null ? '' : String(row.valueJson)).trim();
    if (label) out.set(String(row.entityId), label);
  }
  return out;
}

async function loadActiveDefaultBomKits(engineBrandFilter?: string[]): Promise<AssemblyEngineBrandKit[]> {
  const conditions = [
    eq(erpEngineAssemblyBom.status, 'active'),
    eq(erpEngineAssemblyBom.isDefault, true),
    isNull(erpEngineAssemblyBom.deletedAt),
  ];
  if (engineBrandFilter && engineBrandFilter.length > 0) {
    conditions.push(inArray(erpEngineAssemblyBom.engineBrandId, engineBrandFilter as any));
  }
  const headerRows = await db
    .select()
    .from(erpEngineAssemblyBom)
    .where(and(...conditions));
  if (headerRows.length === 0) return [];
  const bomIds = headerRows.map((row) => String(row.id));
  const brandIds = headerRows.map((row) => String(row.engineBrandId));
  const lineRows = await db
    .select()
    .from(erpEngineAssemblyBomLines)
    .where(and(inArray(erpEngineAssemblyBomLines.bomId, bomIds as any), isNull(erpEngineAssemblyBomLines.deletedAt)));
  const componentIds = Array.from(new Set(lineRows.map((row) => String(row.componentNomenclatureId))));
  const nomenclatureRows =
    componentIds.length > 0
      ? await db
          .select({ id: erpNomenclature.id, code: erpNomenclature.code, name: erpNomenclature.name })
          .from(erpNomenclature)
          .where(inArray(erpNomenclature.id, componentIds as any))
      : [];
  const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
  const brandLabels = await loadEngineBrandDisplayNames(brandIds);
  const linesByBom = new Map<string, typeof lineRows>();
  for (const line of lineRows) {
    const bomId = String(line.bomId);
    const arr = linesByBom.get(bomId) ?? [];
    arr.push(line);
    linesByBom.set(bomId, arr);
  }
  const kits: AssemblyEngineBrandKit[] = [];
  for (const header of headerRows) {
    const engineBrandId = String(header.engineBrandId);
    const brandTitle = displayEngineBrandTitle(engineBrandId, brandLabels.get(engineBrandId) ?? engineBrandId);
    const bomLines = linesByBom.get(String(header.id)) ?? [];
    const lineRecords = bomLines
      .map((line) => {
        const compId = String(line.componentNomenclatureId);
        const compMeta = nomenclatureById.get(compId);
        const qtyPerEngine = Math.max(0, Math.trunc(Number(line.qtyPerUnit ?? 0)));
        if (!compId || qtyPerEngine <= 0) return null;
        const meta = parseWarehouseBomLineMeta(line.notes);
        const variantGroup = String(line.variantGroup ?? '').trim() || null;
        return {
          compId,
          qtyPerEngine,
          role: bomComponentTypeToRole(String(line.componentType)),
          partLabel: partLabelForAssemblyForecast(compMeta, compId),
          variantGroup,
          lineKey: meta.lineKey,
          parentLineKey: meta.parentLineKey,
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    const baseLines = lineRecords.filter((line) => !line.variantGroup);
    const grouped = new Map<string, typeof lineRecords>();
    for (const line of lineRecords) {
      if (!line.variantGroup) continue;
      const arr = grouped.get(line.variantGroup) ?? [];
      arr.push(line);
      grouped.set(line.variantGroup, arr);
    }

    const technicalGroupKeys = Array.from(grouped.keys())
      .filter((k) => String(k).startsWith('__kit_'))
      .sort((a, b) => String(a).localeCompare(String(b)));

    const groupEntries = grouped.size > 0 ? Array.from(grouped.entries()) : [[null, []] as const];
    for (const [groupKey, groupLines] of groupEntries) {
      const merged = [...baseLines, ...groupLines];
      const lineKeySet = new Set(merged.map((line) => line.lineKey).filter((key): key is string => Boolean(key)));
      const filtered = merged.filter((line) => !line.parentLineKey || lineKeySet.has(line.parentLineKey));
      const parts = filtered.map((line) => ({
        partId: line.compId,
        nomenclatureId: line.compId,
        qtyPerEngine: line.qtyPerEngine,
        role: line.role,
        partLabel: line.partLabel,
      }));
      if (parts.length === 0) continue;
      const displayBrandLabel = assemblyForecastBrandLabelForVariant(brandTitle, groupKey, technicalGroupKeys);
      kits.push({
        brandId: groupKey ? `${engineBrandId}::${groupKey}` : engineBrandId,
        brandLabel: displayBrandLabel,
        parts,
      });
    }
  }
  return kits;
}

export async function computeAssemblyForecastFromServer(args: ForecastRequest) {
  const horizonDays = Math.max(1, Math.min(31, Math.floor(Number(args.horizonDays ?? 7))));
  const targetEnginesPerDay = Math.max(0, Math.floor(Number(args.targetEnginesPerDay ?? 0)));
  const sameBrandBatchSize = Math.max(1, Math.floor(Number(args.sameBrandBatchSize ?? 2)));
  const warehouseIds = Array.isArray(args.warehouseIds) ? args.warehouseIds.map(String) : undefined;
  const engineBrandIds = Array.isArray(args.engineBrandIds) ? args.engineBrandIds.map(String) : undefined;
  const priorityEngineBrandIds = Array.isArray(args.priorityEngineBrandIds)
    ? args.priorityEngineBrandIds.map((id) => String(id).trim()).filter(Boolean)
    : undefined;
  const workingWeekdays = Array.isArray(args.workingWeekdays)
    ? args.workingWeekdays.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6)
    : undefined;
  const dbIncomingLines = await loadPlannedIncomingLines({
    horizonDays,
    ...(warehouseIds ? { warehouseIds } : {}),
  });
  const kits = await loadActiveDefaultBomKits(engineBrandIds);
  if (kits.length === 0) {
    return {
      rows: [],
      warnings: ['Нет активных default BOM для выбранных марок двигателей.'],
      deficitRecommendations: [],
      horizonMissingByBrand: [],
      horizonComponentNeeds: [],
    };
  }
  const [stock, whLabels] = await Promise.all([loadNomenclatureStockMap(warehouseIds), loadWarehouseIdToLabelMap()]);
  const warehouseStockBins = await loadNomenclatureWarehouseBins(warehouseIds, whLabels);

  return computeAssemblyForecast({
    horizonDays,
    targetEnginesPerDay,
    sameBrandBatchSize,
    warehouseId: warehouseIds?.length === 1 ? warehouseIds[0]! : null,
    kits,
    stockByNomenclatureId: stock,
    warehouseStockBins,
    incomingLines: dbIncomingLines,
    ...(priorityEngineBrandIds?.length ? { priorityEngineBrandIds } : {}),
    ...(workingWeekdays?.length ? { workingWeekdays } : {}),
  });
}
