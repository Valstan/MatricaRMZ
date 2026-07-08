import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import {
  buildRepairIncomingFromWorkOrderPayloads,
  computeAssemblyForecast,
  EntityTypeCode,
  workshopWarehouseId,
  type AssemblyComponentRole,
  type AssemblyEngineBrandKit,
  type AssemblyWarehouseStockBin,
} from '@matricarmz/shared';

import { resolvePartIdToNomenclatureMap } from './workOrderClosingService.js';

import { db } from '../database/db.js';
import {
  listWarehouseLocations,
  resolveWarehouseLocationIdByCode,
  WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS_UUID,
  WAREHOUSE_LOCATION_REPAIR_FUND_UUID,
  WAREHOUSE_LOCATION_SCRAP_UUID,
} from './warehouseLocationsService.js';
import {
  attributeDefs,
  attributeValues,
  directoryWorkshops,
  entityTypes,
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpPlannedIncoming,
  erpRegStockBalance,
  operations,
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
  /** Максимум двигателей по базовой марке за весь горизонт (контракт / только на заводе). */
  brandMaxEnginesHorizon?: Record<string, number>;
};

// Ф5 актов (GAP-5): технические локации не считаются «доступным для сборки» стоком —
// repair_fund (неотремонтированный фонд), scrap (утиль), assembly_in_progress (детали
// уже внутри собираемых двигателей). При пустом фильтре складов прогноз раньше
// агрегировал их как годные. Явный выбор локации фильтром — уважается.
const FORECAST_EXCLUDED_LOCATION_UUIDS = new Set<string>([
  WAREHOUSE_LOCATION_REPAIR_FUND_UUID,
  WAREHOUSE_LOCATION_SCRAP_UUID,
  WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS_UUID,
]);

// v1.21.4: фильтр складов работает по `warehouse_location_id` (uuid) —
// `warehouseIds` приходит из UI как список uuid из `warehouse_locations`.
// Раньше сравнивалось с legacy text-колонкой `warehouse_id` ('default'/'main'/...),
// и UI отдавал EAV-uuid из старого `warehouse_ref` справочника — два разных пространства
// ключей не пересекались, фильтр складов в прогнозе никогда не срабатывал.
async function loadNomenclatureStockMap(
  warehouseIds?: string[],
): Promise<{ map: Map<string, number>; unknownLocationPositions: number }> {
  const rows = await db.select().from(erpRegStockBalance);
  const map = new Map<string, number>();
  const unknownLocationNomenclatures = new Set<string>();
  for (const row of rows as any[]) {
    const whLoc = row.warehouseLocationId ? String(row.warehouseLocationId) : '';
    // Технические локации (ремфонд/утиль/в сборке) не годны для сборки — исключаем ВСЕГДА,
    // даже при явном фильтре складов: иначе фильтр, включающий ремфонд, учёл бы тот же сток
    // и здесь, и как приход от открытых ремнарядов (loadOpenRepairIncomingLines) → двойной счёт.
    if (FORECAST_EXCLUDED_LOCATION_UUIDS.has(whLoc)) continue;
    if (warehouseIds?.length && !warehouseIds.includes(whLoc)) continue;
    const nid = row.nomenclatureId ? String(row.nomenclatureId) : '';
    if (!nid) continue;
    const avail = Math.max(0, Math.floor(Number(row.qty ?? 0) - Number(row.reservedQty ?? 0)));
    // Диагностика: остаток на строке без привязки к складу (NULL warehouse_location_id —
    // осиротевшие строки бэкфилла/sync). Учитывается в общем количестве, но не виден по складам.
    if (!whLoc && avail > 0) unknownLocationNomenclatures.add(nid);
    map.set(nid, (map.get(nid) ?? 0) + avail);
  }
  return { map, unknownLocationPositions: unknownLocationNomenclatures.size };
}

// Ремфонд-осведомлённые дефициты (план forecast-remfond-aware-2026-07 Ф1): остатки локации
// repair_fund НЕ входят в годный сток (см. выше), но обогащают рекомендации по дефицитам —
// «сколько дефицита можно закрыть ремонтом вместо закупки». Резерв не вычитаем: фонд не
// резервируется, а сам расход при закрытии ремнаряда клампится по остатку.
async function loadRepairFundStockMap(): Promise<Map<string, number>> {
  const rows = await db.select().from(erpRegStockBalance);
  const map = new Map<string, number>();
  for (const row of rows as any[]) {
    const whLoc = row.warehouseLocationId ? String(row.warehouseLocationId) : '';
    if (whLoc !== WAREHOUSE_LOCATION_REPAIR_FUND_UUID) continue;
    const nid = row.nomenclatureId ? String(row.nomenclatureId) : '';
    if (!nid) continue;
    const qty = Math.max(0, Math.floor(Number(row.qty ?? 0)));
    if (qty <= 0) continue;
    map.set(nid, (map.get(nid) ?? 0) + qty);
  }
  return map;
}

// v1.21.4: карта uuid → имя склада строится из `warehouse_locations` (источник истины).
// Старый `listWarehouseLookups` основан на legacy EAV, который оставался синхронным
// с реальностью только частично.
async function loadWarehouseIdToLabelMap(): Promise<Map<string, string>> {
  try {
    const res = await listWarehouseLocations({ activeOnly: true });
    if (!res.ok) return new Map();
    const m = new Map<string, string>();
    for (const row of res.rows) {
      const id = String(row.id ?? '').trim();
      if (!id) continue;
      const name = String(row.name ?? '').trim();
      m.set(id, name && !isUuidLike(name) ? name : 'Склад');
    }
    return m;
  } catch {
    return new Map();
  }
}

async function loadNomenclatureWarehouseBins(
  warehouseIds: string[] | undefined,
  warehouseLabels: Map<string, string>,
): Promise<Map<string, AssemblyWarehouseStockBin[]>> {
  const rows = await db.select().from(erpRegStockBalance);
  const detail = new Map<string, AssemblyWarehouseStockBin[]>();
  for (const row of rows as any[]) {
    const whLoc = row.warehouseLocationId ? String(row.warehouseLocationId) : '';
    // см. loadNomenclatureStockMap: технические локации исключаем всегда (симметрично годному стоку).
    if (FORECAST_EXCLUDED_LOCATION_UUIDS.has(whLoc)) continue;
    if (warehouseIds?.length && !warehouseIds.includes(whLoc)) continue;
    if (!whLoc) continue;
    const nid = row.nomenclatureId ? String(row.nomenclatureId) : '';
    if (!nid) continue;
    const avail = Math.max(0, Math.floor(Number(row.qty ?? 0) - Number(row.reservedQty ?? 0)));
    if (avail <= 0) continue;
    let label = warehouseLabels.get(whLoc) ?? '';
    if (!label.trim() || isUuidLike(label)) label = 'Склад';
    const arr = detail.get(nid) ?? [];
    arr.push({ warehouseId: whLoc, warehouseLabel: label, qty: avail });
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
    const whLoc = row.warehouseLocationId ? String(row.warehouseLocationId) : '';
    if (args.warehouseIds?.length && !args.warehouseIds.includes(whLoc)) continue;
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

/**
 * Ф5 актов (GAP-5): Repair-наряды, выданные в работу → канал будущего прихода прогноза.
 * Документ ремнаряда создаётся и проводится одним шагом при закрытии, поэтому
 * planned_incoming-окна у ремонта нет — канал собирается прямо из незакрытых нарядов.
 * Фильтр «выдан в работу» (`repairIssued`) применяется в buildRepairIncomingFromWorkOrderPayloads:
 * у ремонта нет статуса «открыт», поэтому черновики не считаются приходом, пока их не выдали.
 * dayOffset=1 (консервативно «готово завтра»; ожидаемой даты в payload наряда нет).
 * Склад строки = склад цеха наряда; фильтр складов прогноза уважается.
 */
async function loadOpenRepairIncomingLines(args: {
  warehouseIds?: string[];
}): Promise<{ lines: Array<{ dayOffset: number; nomenclatureId: string; qty: number }>; positions: number }> {
  const rows = await db
    .select({ metaJson: operations.metaJson })
    .from(operations)
    .where(and(eq(operations.operationType, 'work_order'), ne(operations.status, 'closed'), isNull(operations.deletedAt)));
  const payloads: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!row.metaJson) continue;
    try {
      const value = JSON.parse(String(row.metaJson)) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) payloads.push(value as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  const repairLines = buildRepairIncomingFromWorkOrderPayloads(payloads);
  if (repairLines.length === 0) return { lines: [], positions: 0 };

  // workshopId → location uuid склада цеха (для фильтра складов прогноза).
  const workshopIds = [...new Set(repairLines.map((l) => l.workshopId).filter((id): id is string => !!id))];
  const workshopLocationByWorkshopId = new Map<string, string>();
  if (workshopIds.length > 0) {
    const wsRows = await db
      .select({ id: directoryWorkshops.id, code: directoryWorkshops.code })
      .from(directoryWorkshops)
      .where(and(inArray(directoryWorkshops.id, workshopIds), isNull(directoryWorkshops.deletedAt)));
    for (const ws of wsRows) {
      const code = String(ws.code ?? '').trim();
      if (!code) continue;
      const locId = await resolveWarehouseLocationIdByCode(workshopWarehouseId(code));
      if (locId) workshopLocationByWorkshopId.set(String(ws.id), locId);
    }
  }

  // G1: partId строки наряда может быть directory_parts.id — мостим к erp_nomenclature.id,
  // иначе канал не сматчится со стоком/комплектами прогноза.
  const partNomenclMap = await resolvePartIdToNomenclatureMap(repairLines.map((l) => l.partId));

  const byNomenclature = new Map<string, number>();
  for (const line of repairLines) {
    if (args.warehouseIds?.length) {
      const locId = line.workshopId ? workshopLocationByWorkshopId.get(line.workshopId) : null;
      if (!locId || !args.warehouseIds.includes(locId)) continue;
    }
    const nomenclatureId = partNomenclMap.get(line.partId) ?? line.partId;
    byNomenclature.set(nomenclatureId, (byNomenclature.get(nomenclatureId) ?? 0) + line.qty);
  }
  return {
    lines: [...byNomenclature.entries()].map(([nomenclatureId, qty]) => ({ dayOffset: 1, nomenclatureId, qty })),
    positions: byNomenclature.size,
  };
}

function bomComponentTypeToRole(raw: string): AssemblyComponentRole {
  const value = String(raw).trim().toLowerCase();
  if (value === 'sleeve') return 'sleeve';
  if (value === 'piston') return 'piston';
  if (value === 'ring') return 'rings';
  if (value === 'jacket' || value === 'carter') return 'jacket';
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

/**
 * Pure-функция сборки kits из уже загруженных DB-rows. Экспортируется ради unit-тестов:
 * см. `assemblyForecastKitBuilder.test.ts`. Все edge cases v1.22.0:
 *   1. Пустой BOM — warning «BOM марки X не содержит строк», марка пропускается.
 *   2. Строка ссылается на soft-deleted nomenclature — exclude + warning «N строк пропущено».
 *   3. Variant kit неполный (parentLineKey указывает на отсутствующую базовую строку) — warning.
 *   4. Несколько kit-вариантов для одной марки — отдельные комплекты с suffix (без warning, это feature).
 *   5. Несколько active+isDefault BOM для одной марки — используется самый свежий по updatedAt + warning.
 */
/**
 * Коллапс позиций к основному варианту для одного kit'а.
 * Позиция — строки с общим непустым positionKey (взаимозаменяемые варианты детали).
 * В kit оставляется РОВНО ОДИН вариант позиции — основной (isDefaultOption); остальные
 * (запасные) отбрасываются, чтобы прогноз не множил спрос по всем вариантам сразу.
 * Строки с пустым positionKey — позиции-одиночки, проходят как есть. Порядок строк уже
 * отсортирован по priority/createdAt, поэтому «первый» детерминирован.
 */
function collapsePositionsToDefaultOption<
  T extends { positionKey?: string | null; isDefaultOption?: boolean; compId: string; partLabel: string },
>(
  lines: ReadonlyArray<T>,
  brandTitle: string,
  warnings: string[],
  stockByNomenclatureId?: ReadonlyMap<string, number>,
): T[] {
  const singletons: T[] = [];
  const groups = new Map<string, T[]>();
  for (const line of lines) {
    const key = String(line.positionKey ?? '').trim();
    if (!key) {
      singletons.push(line);
      continue;
    }
    const arr = groups.get(key) ?? [];
    arr.push(line);
    groups.set(key, arr);
  }
  const stockOf = (id: string): number => Math.max(0, Math.floor(stockByNomenclatureId?.get(id) ?? 0));
  const chosen: T[] = [...singletons];
  for (const [key, group] of groups) {
    if (group.length === 1) {
      chosen.push(group[0]!);
      continue;
    }
    const defaultOption = group.find((l) => l.isDefaultOption !== false);
    if (!defaultOption) {
      chosen.push(group[0]!);
      warnings.push(
        `BOM марки «${brandTitle}»: у позиции «${key}» не отмечен основной вариант — в прогноз взят первый.`,
      );
      continue;
    }
    // Фаза 3: если основного варианта нет на складе (сток=0), а у запасного есть — в прогноз
    // подставляется запасной с наибольшим остатком (собираем из того, что реально есть).
    // Основной со стоком (или отсутствие stock-мапы) → берётся основной, поведение как раньше.
    if (stockByNomenclatureId && stockOf(defaultOption.compId) <= 0) {
      let substitute: T | null = null;
      let substituteStock = 0;
      for (const opt of group) {
        if (opt === defaultOption) continue;
        const s = stockOf(opt.compId);
        if (s > substituteStock) {
          substituteStock = s;
          substitute = opt;
        }
      }
      if (substitute) {
        chosen.push(substitute);
        warnings.push(
          `BOM марки «${brandTitle}»: позиция «${key}» — основной вариант «${defaultOption.partLabel}» ` +
            `отсутствует на складе, в прогноз подставлен запасной «${substitute.partLabel}» (${substituteStock} шт.).`,
        );
        continue;
      }
    }
    chosen.push(defaultOption);
  }
  return chosen;
}

export function buildAssemblyForecastKits(input: {
  headerRows: ReadonlyArray<{
    id: string;
    name: string | null;
    updatedAt: number | null;
    engineBrandId: string;
  }>;
  lineRows: ReadonlyArray<{
    bomId: string;
    componentNomenclatureId: string;
    componentType: string;
    qtyPerUnit: number;
    variantGroup: string | null;
    notes: string | null;
    positionKey?: string | null;
    isDefaultOption?: boolean;
  }>;
  nomenclatureById: ReadonlyMap<
    string,
    { id: string; code: string | null; name: string | null; deletedAt: number | null }
  >;
  brandLabels: ReadonlyMap<string, string>;
  /** Фаза 3: текущий сток по номенклатуре — для подстановки запасного варианта позиции при отсутствии основного. Опц.: без него позиция коллапсирует к основному как раньше. */
  stockByNomenclatureId?: ReadonlyMap<string, number>;
}): { kits: AssemblyEngineBrandKit[]; warnings: string[] } {
  const warnings: string[] = [];
  if (input.headerRows.length === 0) return { kits: [], warnings };

  // Edge case #5: дедуп по engineBrandId — оставляем самый свежий header по updatedAt.
  const byBrand = new Map<string, typeof input.headerRows[number][]>();
  for (const row of input.headerRows) {
    const brandId = String(row.engineBrandId);
    const arr = byBrand.get(brandId) ?? [];
    arr.push(row);
    byBrand.set(brandId, arr);
  }
  const headerRows: typeof input.headerRows[number][] = [];
  for (const [brandId, rows] of byBrand) {
    if (rows.length === 1) {
      headerRows.push(rows[0]!);
      continue;
    }
    const sorted = [...rows].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    const freshest = sorted[0]!;
    headerRows.push(freshest);
    const brandTitle = displayEngineBrandTitle(brandId, input.brandLabels.get(brandId) ?? brandId);
    const usedName = String(freshest.name ?? '').trim() || freshest.id;
    warnings.push(
      `Несколько активных default BOM для марки «${brandTitle}» (${rows.length}). ` +
        `Используется свежая «${usedName}» — архивируйте ненужные.`,
    );
  }

  const linesByBom = new Map<string, typeof input.lineRows[number][]>();
  for (const line of input.lineRows) {
    const arr = linesByBom.get(String(line.bomId)) ?? [];
    arr.push(line);
    linesByBom.set(String(line.bomId), arr);
  }

  const kits: AssemblyEngineBrandKit[] = [];
  for (const header of headerRows) {
    const engineBrandId = String(header.engineBrandId);
    const brandTitle = displayEngineBrandTitle(engineBrandId, input.brandLabels.get(engineBrandId) ?? engineBrandId);
    const bomLines = linesByBom.get(String(header.id)) ?? [];

    // Edge case #1: BOM без строк — warning, марка пропускается.
    if (bomLines.length === 0) {
      warnings.push(`BOM марки «${brandTitle}» не содержит строк — прогноз для марки не построен.`);
      continue;
    }

    // Edge case #2: фильтр строк, ссылающихся на soft-deleted nomenclature.
    let droppedDueToDeletedNomenclature = 0;
    let fractionalQtyLines = 0;
    const lineRecords = bomLines
      .map((line) => {
        const compId = String(line.componentNomenclatureId);
        const compMeta = input.nomenclatureById.get(compId);
        if (compMeta && compMeta.deletedAt != null) {
          droppedDueToDeletedNomenclature += 1;
          return null;
        }
        const rawQty = Number(line.qtyPerUnit ?? 0);
        // Edge case #6: дробное «кол-во на двигатель» усекается (0.5 → строка выпадает молча).
        if (Number.isFinite(rawQty) && rawQty > 0 && !Number.isInteger(rawQty)) fractionalQtyLines += 1;
        const qtyPerEngine = Math.max(0, Math.trunc(rawQty));
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
          positionKey: String(line.positionKey ?? '').trim() || null,
          isDefaultOption: line.isDefaultOption !== false,
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    if (droppedDueToDeletedNomenclature > 0) {
      warnings.push(
        `BOM марки «${brandTitle}»: пропущено ${droppedDueToDeletedNomenclature} ` +
          `${droppedDueToDeletedNomenclature === 1 ? 'строка' : 'строк'} ` +
          `(ссылается на удалённую номенклатуру).`,
      );
    }
    if (fractionalQtyLines > 0) {
      warnings.push(
        `BOM марки «${brandTitle}»: ${fractionalQtyLines} ` +
          `${fractionalQtyLines === 1 ? 'строка' : 'строк'} с дробным «кол-во на двигатель» — ` +
          `значение усечено до целого (строки с количеством < 1 выпали из прогноза).`,
      );
    }

    if (lineRecords.length === 0) {
      warnings.push(`BOM марки «${brandTitle}» не содержит валидных строк — прогноз для марки не построен.`);
      continue;
    }

    const baseLines = lineRecords.filter((line) => !line.variantGroup);
    const grouped = new Map<string, typeof lineRecords>();
    for (const line of lineRecords) {
      if (!line.variantGroup) continue;
      const arr = grouped.get(line.variantGroup) ?? [];
      arr.push(line);
      grouped.set(line.variantGroup, arr);
    }

    const technicalGroupKeys = Array.from(grouped.keys()).filter((k) => String(k).startsWith('__kit_'));

    const groupEntries = grouped.size > 0 ? Array.from(grouped.entries()) : [[null, []] as const];
    for (const [groupKey, groupLines] of groupEntries) {
      const merged = [...baseLines, ...groupLines];
      const lineKeySet = new Set(merged.map((line) => line.lineKey).filter((key): key is string => Boolean(key)));
      const filtered = merged.filter((line) => !line.parentLineKey || lineKeySet.has(line.parentLineKey));
      // Edge case #3: variant kit неполный — parentLineKey ссылается на отсутствующую строку.
      const droppedDueToBrokenParent = merged.length - filtered.length;
      if (droppedDueToBrokenParent > 0) {
        const variantLabel = groupKey ? ` (вариант ${groupKey})` : '';
        warnings.push(
          `BOM марки «${brandTitle}»${variantLabel}: пропущено ${droppedDueToBrokenParent} ` +
            `${droppedDueToBrokenParent === 1 ? 'строка' : 'строк'} с broken parentLineKey.`,
        );
      }
      // Коллапс позиции к основному варианту: у позиции (общий positionKey) может быть
      // несколько взаимозаменяемых деталей, но собирают из ОДНОЙ — основной (isDefaultOption).
      // В прогноз попадает только основной вариант; иначе спрос множился бы по всем вариантам.
      // Легаси-строки (positionKey=null) — позиции-одиночки, берутся как есть → поведение не меняется.
      const kitLines = collapsePositionsToDefaultOption(filtered, brandTitle, warnings, input.stockByNomenclatureId);
      const parts = kitLines.map((line) => ({
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
  return { kits, warnings };
}

/** Thin wrapper: DB queries → buildAssemblyForecastKits. */
async function loadActiveDefaultBomKits(
  engineBrandFilter?: string[],
  stockByNomenclatureId?: ReadonlyMap<string, number>,
): Promise<{ kits: AssemblyEngineBrandKit[]; warnings: string[] }> {
  // Edge case #7: активный default BOM вовсе без активной brand-link молча выпадает
  // из innerJoin ниже (backfill 0042+0047 гарантировал link, но диагностика нужна).
  const linklessRows = await db
    .select({ id: erpEngineAssemblyBom.id, name: erpEngineAssemblyBom.name })
    .from(erpEngineAssemblyBom)
    .leftJoin(
      erpEngineAssemblyBomBrandLinks,
      and(
        eq(erpEngineAssemblyBomBrandLinks.bomId, erpEngineAssemblyBom.id),
        isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
      ),
    )
    .where(
      and(
        eq(erpEngineAssemblyBom.status, 'active'),
        eq(erpEngineAssemblyBom.isDefault, true),
        isNull(erpEngineAssemblyBom.deletedAt),
        isNull(erpEngineAssemblyBomBrandLinks.id),
      ),
    );
  const linklessWarnings = linklessRows.map(
    (row) =>
      `Активный default BOM «${String(row.name ?? row.id)}» не связан ни с одной маркой двигателя — исключён из прогноза.`,
  );

  const conditions = [
    eq(erpEngineAssemblyBom.status, 'active'),
    eq(erpEngineAssemblyBom.isDefault, true),
    isNull(erpEngineAssemblyBom.deletedAt),
    isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
  ];
  if (engineBrandFilter && engineBrandFilter.length > 0) {
    conditions.push(inArray(erpEngineAssemblyBomBrandLinks.engineBrandId, engineBrandFilter as any));
  }
  // Один BOM может быть связан с несколькими марками — раскрываем JOIN'ом junction, получая пары (bom, brandId).
  const headerRowsRaw = await db
    .select({
      id: erpEngineAssemblyBom.id,
      name: erpEngineAssemblyBom.name,
      updatedAt: erpEngineAssemblyBom.updatedAt,
      engineBrandId: erpEngineAssemblyBomBrandLinks.engineBrandId,
      isPrimary: erpEngineAssemblyBomBrandLinks.isPrimary,
    })
    .from(erpEngineAssemblyBom)
    .innerJoin(
      erpEngineAssemblyBomBrandLinks,
      eq(erpEngineAssemblyBomBrandLinks.bomId, erpEngineAssemblyBom.id),
    )
    .where(and(...conditions));
  if (headerRowsRaw.length === 0) return { kits: [], warnings: linklessWarnings };

  const bomIds = Array.from(new Set(headerRowsRaw.map((row) => String(row.id))));
  const brandIds = Array.from(new Set(headerRowsRaw.map((row) => String(row.engineBrandId))));
  const lineRows = await db
    .select()
    .from(erpEngineAssemblyBomLines)
    .where(and(inArray(erpEngineAssemblyBomLines.bomId, bomIds as any), isNull(erpEngineAssemblyBomLines.deletedAt)))
    .orderBy(asc(erpEngineAssemblyBomLines.priority), asc(erpEngineAssemblyBomLines.createdAt));
  const componentIds = Array.from(new Set(lineRows.map((row) => String(row.componentNomenclatureId))));
  // v1.22.0: загружаем все строки (включая soft-deleted) — нужно для warning «строка ссылается на удалённую номенклатуру».
  const nomenclatureRows =
    componentIds.length > 0
      ? await db
          .select({
            id: erpNomenclature.id,
            code: erpNomenclature.code,
            name: erpNomenclature.name,
            deletedAt: erpNomenclature.deletedAt,
          })
          .from(erpNomenclature)
          .where(inArray(erpNomenclature.id, componentIds as any))
      : [];
  const nomenclatureById = new Map(
    nomenclatureRows.map((row) => [
      String(row.id),
      {
        id: String(row.id),
        code: row.code == null ? null : String(row.code),
        name: row.name == null ? null : String(row.name),
        deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
      },
    ]),
  );
  const brandLabels = await loadEngineBrandDisplayNames(brandIds);

  const built = buildAssemblyForecastKits({
    headerRows: headerRowsRaw.map((row) => ({
      id: String(row.id),
      name: row.name == null ? null : String(row.name),
      updatedAt: row.updatedAt == null ? null : Number(row.updatedAt),
      engineBrandId: String(row.engineBrandId),
    })),
    lineRows: lineRows.map((line) => ({
      bomId: String(line.bomId),
      componentNomenclatureId: String(line.componentNomenclatureId ?? ''),
      componentType: String(line.componentType ?? ''),
      qtyPerUnit: Number(line.qtyPerUnit ?? 0),
      variantGroup: line.variantGroup == null ? null : String(line.variantGroup),
      notes: line.notes == null ? null : String(line.notes),
      positionKey: line.positionKey == null ? null : String(line.positionKey),
      isDefaultOption: line.isDefaultOption !== false,
    })),
    nomenclatureById,
    brandLabels,
    ...(stockByNomenclatureId ? { stockByNomenclatureId } : {}),
  });
  return { kits: built.kits, warnings: [...linklessWarnings, ...built.warnings] };
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
  let brandMaxEnginesHorizon: Map<string, number> | undefined;
  if (args.brandMaxEnginesHorizon && typeof args.brandMaxEnginesHorizon === 'object') {
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(args.brandMaxEnginesHorizon)) {
      const id = String(k).trim();
      const n = Math.max(0, Math.floor(Number(v)));
      if (id.length > 0 && Number.isFinite(n)) m.set(id, n);
    }
    if (m.size > 0) brandMaxEnginesHorizon = m;
  }
  const dbIncomingLines = await loadPlannedIncomingLines({
    horizonDays,
    ...(warehouseIds ? { warehouseIds } : {}),
  });
  // Ф5 (GAP-5): открытые ремнаряды — будущий приход отремонтированных деталей.
  const repairIncoming = await loadOpenRepairIncomingLines({ ...(warehouseIds ? { warehouseIds } : {}) });
  // Фаза 3: сток нужен ДО сборки китов — при отсутствии основного варианта позиции на складе
  // в прогноз подставляется запасной. (No-kits early-return ниже смещается на эти 3 запроса — приемлемо.)
  const [stockResult, whLabels, repairFundStock] = await Promise.all([
    loadNomenclatureStockMap(warehouseIds),
    loadWarehouseIdToLabelMap(),
    loadRepairFundStockMap(),
  ]);
  const stock = stockResult.map;
  const { kits, warnings: kitWarnings } = await loadActiveDefaultBomKits(engineBrandIds, stock);
  if (kits.length === 0) {
    return {
      rows: [],
      warnings: ['Нет активных default BOM для выбранных марок двигателей.', ...kitWarnings],
      deficitRecommendations: [],
      horizonMissingByBrand: [],
      horizonComponentNeeds: [],
      existingAssemblyOrdersByVariantKey: {} as Record<string, { operationId: string; workOrderNumber: number }>,
    };
  }
  const stockDataNotes =
    stockResult.unknownLocationPositions > 0
      ? [
          `Внимание: ${stockResult.unknownLocationPositions} позиц. с остатком без привязки к складу — ` +
            `учтены в общем количестве, но не показаны по складам. Проверьте склад у этих позиций.`,
        ]
      : [];
  const warehouseStockBins = await loadNomenclatureWarehouseBins(warehouseIds, whLabels);

  const result = computeAssemblyForecast({
    horizonDays,
    targetEnginesPerDay,
    sameBrandBatchSize,
    warehouseId: warehouseIds?.length === 1 ? warehouseIds[0]! : null,
    kits,
    stockByNomenclatureId: stock,
    warehouseStockBins,
    repairFundByNomenclatureId: repairFundStock,
    incomingLines: [...dbIncomingLines, ...repairIncoming.lines],
    ...(priorityEngineBrandIds?.length ? { priorityEngineBrandIds } : {}),
    ...(workingWeekdays?.length ? { workingWeekdays } : {}),
    ...(brandMaxEnginesHorizon && brandMaxEnginesHorizon.size > 0 ? { brandMaxEnginesHorizon } : {}),
  });
  // Stage 4 нитки assembly-work-order-from-forecast: подтянуть активные Assembly-наряды
  // с forecastVariantKey, чтобы UI заблокировал кнопку «Создать наряд» для уже выписанных вариантов.
  const existingAssemblyOrdersByVariantKey = await loadActiveAssemblyOrdersByVariantKey();
  // Edge-case warnings из loadActiveDefaultBomKits идут перед runtime-warnings из чистой логики (порядок важен для UI).
  // Ф5 (GAP-5): нота про канал открытых ремнарядов — оператор видит, что приход «завтра» включён в расчёт.
  const repairChannelNotes =
    repairIncoming.positions > 0
      ? [`Учтены ремнаряды, выданные в работу: ${repairIncoming.positions} позиц. деталей ожидаются как приход (день +1).`]
      : [];
  return {
    ...result,
    warnings: [...kitWarnings, ...repairChannelNotes, ...stockDataNotes, ...result.warnings],
    existingAssemblyOrdersByVariantKey,
  };
}

/**
 * Stage 4: пробегаемся по `operations` типа work_order в статусе open (не closed, не deleted),
 * парсим metaJson и матчим Assembly-наряды с непустым forecastVariantKey.
 * Возвращаем Map { variantKey → { operationId, workOrderNumber } }.
 *
 * Closed assembly-наряды не включаем — variantKey содержит dayOffset (относительный),
 * который для прошлых дней не совпадает с сегодняшним прогнозом (повторного матчинга не будет).
 */
async function loadActiveAssemblyOrdersByVariantKey(): Promise<Record<string, { operationId: string; workOrderNumber: number }>> {
  const rows = await db
    .select({ id: operations.id, status: operations.status, metaJson: operations.metaJson })
    .from(operations)
    .where(
      and(
        eq(operations.operationType, 'work_order'),
        eq(operations.status, 'open'),
        isNull(operations.deletedAt),
      ),
    );
  const result: Record<string, { operationId: string; workOrderNumber: number }> = {};
  for (const row of rows) {
    if (!row.metaJson) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(String(row.metaJson)) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.workOrderKind !== 'assembly') continue;
    const variantKey = typeof parsed.forecastVariantKey === 'string' ? parsed.forecastVariantKey.trim() : '';
    if (!variantKey) continue;
    const workOrderNumber = Number(parsed.workOrderNumber ?? 0);
    result[variantKey] = { operationId: String(row.id), workOrderNumber };
  }
  return result;
}
