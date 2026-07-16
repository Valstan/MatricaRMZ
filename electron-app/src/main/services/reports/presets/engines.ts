import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  STATUS_CODES,
  computeObjectProgress,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  ENGINE_INVENTORY_STAGE,
  formatEngineInternalNumber,
  selectEnginesListReportColumns,
  } from '@matricarmz/shared';

import {
  erpEngineAssemblyBom,
  erpRegStockBalance,
  operations,
} from '../../../database/schema.js';



import { resolveEngineShippingState } from '../../reportEngineShippingState.js';

import { resolveContractLabel, toNumber, normalizeText, asArray, asNumberOrNull, readPeriod, msToDate, stageLabel, stageProgressFallback } from '../format.js';
import { getWarehouseLocationsById, getPreset, loadSnapshot, getIdsByType, type ReportBuildContext } from '../context.js';
import { buildOptions, buildCounterpartyOptions, resolveCounterpartyLabel } from '../options.js';

export async function buildEngineStagesReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const contractFilter = asArray(filters?.contractIds);
  const brandFilter = asArray(filters?.brandIds);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const snapshot = await loadSnapshot(db);
  const latestOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), lte(operations.createdAt, period.endMs)))
    .limit(250_000);
  const latestByEngine = new Map<string, { stage: string; ts: number }>();
  for (const row of latestOps as any[]) {
    const engineId = String(row.engineEntityId ?? '');
    if (!engineId) continue;
    const ts = Number(row.performedAt ?? row.createdAt ?? 0);
    const prev = latestByEngine.get(engineId);
    if (!prev || ts > prev.ts) latestByEngine.set(engineId, { stage: String(row.operationType), ts });
  }
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const engineId of getIdsByType(snapshot, 'engine')) {
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const latest = latestByEngine.get(engineId);
    if (!latest) continue;
    if (period.startMs != null && latest.ts < period.startMs) continue;
    const contractId = normalizeText(attrs.contract_id, '');
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const counterpartyId = normalizeText(attrs.counterparty_id ?? attrs.customer_id, '');
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
    for (const code of STATUS_CODES) statusFlags[code] = Boolean(attrs[code]);
    const calculated = computeObjectProgress(statusFlags);
    const progressPct = calculated > 0 ? calculated : stageProgressFallback(latest.stage);
    rows.push({
      engineNumber: normalizeText(attrs.engine_number ?? attrs.number, engineId),
      engineInternalNumber: formatEngineInternalNumber(
        normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
        attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
      ),
      engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      currentStage: stageLabel(latest.stage),
      progressPct,
      arrivalDate: asNumberOrNull(attrs.acceptance_at ?? attrs.arrival_date),
      lastOperationAt: latest.ts,
    });
  }
  rows.sort((a, b) => String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru') || String(a.engineNumber ?? '').localeCompare(String(b.engineNumber ?? ''), 'ru'));
  const grouped = new Map<string, { count: number; progressPct: number }>();
  for (const row of rows) {
    const key = String(row.contractLabel ?? '(не указан)');
    const g = grouped.get(key) ?? { count: 0, progressPct: 0 };
    g.count += 1;
    g.progressPct += toNumber(row.progressPct);
    grouped.set(key, g);
  }
  const totalsByGroup = Array.from(grouped.entries()).map(([group, g]) => ({
    group,
    totals: { engines: g.count, progressPct: g.count ? g.progressPct / g.count : 0 },
  }));
  const totalProgress = rows.reduce((acc, row) => acc + toNumber(row.progressPct), 0);
  const preset = getPreset('engine_stages');
  return {
    ok: true,
    presetId: 'engine_stages',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: { engines: rows.length, progressPct: rows.length ? totalProgress / rows.length : 0 },
    totalsByGroup,
    generatedAt: Date.now(),
  };
}


export async function buildEngineMovementsReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const contractFilter = asArray(filters?.contractIds);
  const brandFilter = asArray(filters?.brandIds);
  const eventType = normalizeText(filters?.eventType, 'all');
  const snapshot = await loadSnapshot(db);
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const allowed = ['acceptance', 'shipment', 'customer_delivery'];
  const rows: Array<Record<string, ReportCellValue>> = [];
  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), inArray(operations.operationType, allowed as any), lte(operations.createdAt, period.endMs)))
    .limit(200_000);
  for (const op of sourceOps as any[]) {
    const opType = String(op.operationType ?? '');
    if (eventType !== 'all' && opType !== eventType) continue;
    const ts = Number(op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && ts < period.startMs) continue;
    if (ts > period.endMs) continue;
    const engineId = String(op.engineEntityId ?? '');
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const contractId = normalizeText(attrs.contract_id, '');
    const counterpartyId = normalizeText(attrs.counterparty_id ?? attrs.customer_id, '');
    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
    rows.push({
      eventAt: ts,
      eventTypeLabel: stageLabel(opType),
      engineNumber: normalizeText(attrs.engine_number ?? attrs.number, engineId),
      engineInternalNumber: formatEngineInternalNumber(
        normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
        attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
      ),
      engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      note: normalizeText(op.note, ''),
    });
  }
  rows.sort((a, b) => toNumber(b.eventAt) - toNumber(a.eventAt));
  const accepted = rows.filter((r) => String(r.eventTypeLabel) === stageLabel('acceptance')).length;
  const shipped = rows.filter((r) => String(r.eventTypeLabel) === stageLabel('shipment')).length;
  const delivered = rows.filter((r) => String(r.eventTypeLabel) === stageLabel('customer_delivery')).length;
  const preset = getPreset('engine_movements');
  return {
    ok: true,
    presetId: 'engine_movements',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: { acceptance: accepted, shipment: shipped, customer_delivery: delivered },
    generatedAt: Date.now(),
  };
}

// Акт комплектности «заполнен» = в списке деталей (engine_inventory) хотя бы одна деталь
// отмечена «на месте» (present) — тот же критерий, что hasCompletenessAct в engineService.
export async function getCompletenessActStartedMap(db: BetterSQLite3Database): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const opRows = await db
    .select({ engineEntityId: operations.engineEntityId, metaJson: operations.metaJson, updatedAt: operations.updatedAt })
    .from(operations)
    .where(and(eq(operations.operationType, ENGINE_INVENTORY_STAGE), isNull(operations.deletedAt)))
    .orderBy(desc(operations.updatedAt));
  for (const op of opRows as any[]) {
    const engineId = String(op?.engineEntityId ?? '').trim();
    if (!engineId || result.has(engineId)) continue;
    let started = false;
    try {
      const payload = op.metaJson ? JSON.parse(String(op.metaJson)) : null;
      const table = payload?.answers?.engine_inventory_items;
      const tableRows = table?.kind === 'table' && Array.isArray(table.rows) ? table.rows : [];
      started = tableRows.some((r: any) => r?.present === true || r?.present === 'true' || r?.present === 1 || r?.present === '1');
    } catch {
      started = false;
    }
    result.set(engineId, started);
  }
  return result;
}

export async function buildEnginesListReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const arrivalStart = asNumberOrNull(filters?.arrivalStartMs);
  const arrivalEnd = asNumberOrNull(filters?.arrivalEndMs);
  const repairStartStart = asNumberOrNull(filters?.repairStartStartMs);
  const repairStartEnd = asNumberOrNull(filters?.repairStartEndMs);
  const repairEndStart = asNumberOrNull(filters?.repairEndStartMs);
  const repairEndEnd = asNumberOrNull(filters?.repairEndEndMs);
  const shippingStart = asNumberOrNull(filters?.shippingStartMs);
  const shippingEnd = asNumberOrNull(filters?.shippingEndMs);
  const brandFilter = asArray(filters?.brandIds);
  const contractFilter = asArray(filters?.contractIds);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const scrapFilter = normalizeText(filters?.scrapFilter, 'all');
  const onSiteFilter = normalizeText(filters?.onSiteFilter, 'all');
  const completenessActFilter = normalizeText(filters?.completenessActFilter, 'all');
  const columnKeys = asArray(filters?.columns);

  const completenessActByEngineId = await getCompletenessActStartedMap(db);
  const snapshot = await loadSnapshot(db);
  const engineTypeId = snapshot.entityTypeIdByCode.get('engine');
  if (!engineTypeId) return { ok: false, error: 'Тип сущности "engine" не найден' };

  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));

  const rows: Array<Record<string, ReportCellValue>> = [];
  let totalScrap = 0;
  let totalOnSite = 0;

  for (const [id, entity] of snapshot.entitiesById.entries()) {
    if (entity.typeId !== engineTypeId) continue;
    const attrs = snapshot.attrsByEntity.get(id) ?? {};

    const createdAtRaw = toNumber(attrs.created_at);
    const arrivalDateRaw = toNumber(attrs.arrival_date);
    const repairStartedRaw = toNumber(attrs.status_repair_started_date);
    const repairedRaw = toNumber(attrs.status_repaired_date);
    const { shippingDate, onSite } = resolveEngineShippingState(attrs);
    const isScrap = attrs.is_scrap === true || attrs.is_scrap === 'true' || attrs.is_scrap === 1;
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const contractId = normalizeText(attrs.contract_id, '');
    const counterpartyId = normalizeText(attrs.counterparty_id ?? attrs.customer_id, '');

    if (period.startMs != null && createdAtRaw > 0 && createdAtRaw < period.startMs) continue;
    if (createdAtRaw > 0 && createdAtRaw > period.endMs) continue;

    if (arrivalStart != null && (arrivalDateRaw <= 0 || arrivalDateRaw < arrivalStart)) continue;
    if (arrivalEnd != null && (arrivalDateRaw <= 0 || arrivalDateRaw > arrivalEnd)) continue;

    if (repairStartStart != null && (repairStartedRaw <= 0 || repairStartedRaw < repairStartStart)) continue;
    if (repairStartEnd != null && (repairStartedRaw <= 0 || repairStartedRaw > repairStartEnd)) continue;

    if (repairEndStart != null && (repairedRaw <= 0 || repairedRaw < repairEndStart)) continue;
    if (repairEndEnd != null && (repairedRaw <= 0 || repairedRaw > repairEndEnd)) continue;

    if (shippingStart != null && (shippingDate == null || shippingDate < shippingStart)) continue;
    if (shippingEnd != null && (shippingDate == null || shippingDate > shippingEnd)) continue;

    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;

    if (scrapFilter === 'yes' && !isScrap) continue;
    if (scrapFilter === 'no' && isScrap) continue;

    if (onSiteFilter === 'yes' && !onSite) continue;
    if (onSiteFilter === 'no' && onSite) continue;

    const completenessActStarted = completenessActByEngineId.get(id) === true;
    if (completenessActFilter === 'yes' && !completenessActStarted) continue;
    if (completenessActFilter === 'no' && completenessActStarted) continue;

    if (isScrap) totalScrap++;
    if (onSite) totalOnSite++;

    rows.push({
      engineNumber: normalizeText(attrs.engine_number ?? attrs.number, id),
      engineInternalNumber: formatEngineInternalNumber(
        normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
        attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
      ),
      engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      arrivalDate: arrivalDateRaw > 0 ? arrivalDateRaw : null,
      repairStartedDate: repairStartedRaw > 0 ? repairStartedRaw : null,
      repairedDate: repairedRaw > 0 ? repairedRaw : null,
      shippingDate,
      isScrap: isScrap ? 'Да' : 'Нет',
      completenessAct: completenessActStarted ? 'Да' : 'Нет',
    });
  }

  rows.sort((a, b) => toNumber(b.arrivalDate) - toNumber(a.arrivalDate));

  const preset = getPreset('engines_list');
  return {
    ok: true,
    presetId: 'engines_list',
    title: preset.title,
    subtitle: period.startMs ? `${msToDate(period.startMs)} — ${msToDate(period.endMs)}` : `по ${msToDate(period.endMs)}`,
    columns: selectEnginesListReportColumns(columnKeys),
    rows,
    totals: {
      engines: rows.length,
      scrapQty: totalScrap,
      onSiteQty: totalOnSite,
    },
    generatedAt: Date.now(),
  };
}


export async function buildEngineReadinessToAssembleReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const brandFilter = asArray(filters?.engineBrandIds);
  const showOnlyShortages = Boolean((filters as Record<string, unknown> | undefined)?.showOnlyShortages);
  const snapshot = await loadSnapshot(db);
  const engineTypeId = snapshot.entityTypeIdByCode.get('engine');
  if (!engineTypeId) {
    const preset = getPreset('engine_readiness_to_assemble');
    return {
      ok: true,
      presetId: 'engine_readiness_to_assemble',
      title: preset.title,
      subtitle: 'Нет сущностей-двигателей',
      columns: preset.columns,
      rows: [],
      generatedAt: Date.now(),
    };
  }

  // Phase 2.4 PR 2.5: считаем доступные остатки в цеховых складах + repair_fund через uuid lookup.
  const locByUuid = await getWarehouseLocationsById(ctx);
  const balanceRows = await db.select().from(erpRegStockBalance);
  const stockByNom = new Map<string, number>();
  for (const raw of balanceRows as Array<Record<string, unknown>>) {
    const warehouseLocationId = String(raw.warehouseLocationId ?? '');
    const legacyWarehouseId = String(raw.warehouseId ?? '');
    const loc = locByUuid.get(warehouseLocationId);
    const include = loc
      ? loc.type === 'workshop' || loc.code === 'repair_fund'
      : legacyWarehouseId.startsWith('workshop_') || legacyWarehouseId === 'repair_fund';
    if (!include) continue;
    const nomenclatureId = String(raw.nomenclatureId ?? '');
    if (!nomenclatureId) continue;
    const avail = Math.max(0, Math.floor(Number(raw.qty ?? 0) - Number(raw.reservedQty ?? 0)));
    stockByNom.set(nomenclatureId, (stockByNom.get(nomenclatureId) ?? 0) + avail);
  }

  let bomLines: Array<Record<string, unknown>> = [];
  try {
    bomLines = (await db.select().from(erpEngineAssemblyBom)) as Array<Record<string, unknown>>;
  } catch {
    bomLines = [];
  }

  const engineRows = Array.from(snapshot.entitiesById.values()).filter((e) => e.typeId === engineTypeId);
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const engine of engineRows) {
    const attrs = snapshot.attrsByEntity.get(engine.id) ?? {};
    const brandId = String(attrs.engine_brand_id ?? '').trim();
    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    const phase = String(attrs.engine_phase ?? '').trim();
    if (phase && phase !== 'received' && phase !== 'disassembled') continue;
    const engineNumber = normalizeText(attrs.serial_number, normalizeText(attrs.name, engine.id));
    const engineInternalNumber = formatEngineInternalNumber(
      normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
      attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
    );
    const brandLabel = brandId ? normalizeText(snapshot.attrsByEntity.get(brandId)?.name, brandId) : '';

    const totalComponents = bomLines.length;
    const shortages: Array<{ name: string; need: number; have: number }> = [];
    for (const line of bomLines) {
      const nomenclatureId = String((line as Record<string, unknown>).componentNomenclatureId ?? '');
      const need = Math.max(0, Math.floor(Number((line as Record<string, unknown>).qtyPerUnit ?? 0)));
      if (need === 0 || !nomenclatureId) continue;
      const have = stockByNom.get(nomenclatureId) ?? 0;
      if (have < need) {
        shortages.push({
          name: `${nomenclatureId.slice(0, 8)}`,
          need,
          have,
        });
      }
    }
    const totalShortQty = shortages.reduce((acc, s) => acc + Math.max(0, s.need - s.have), 0);
    if (showOnlyShortages && shortages.length === 0) continue;

    rows.push({
      engineNumber,
      engineInternalNumber,
      engineBrand: brandLabel,
      enginePhase: phase || '—',
      totalComponents,
      componentsShort: shortages.length,
      totalShortQty,
      shortageSummary: shortages
        .slice(0, 5)
        .map((s) => `${s.name}: ${s.have}/${s.need}`)
        .join('; '),
    });
  }
  rows.sort((a, b) => Number(b.componentsShort ?? 0) - Number(a.componentsShort ?? 0));
  const preset = getPreset('engine_readiness_to_assemble');
  return {
    ok: true,
    presetId: 'engine_readiness_to_assemble',
    title: preset.title,
    subtitle: rows.length === 0 ? 'Нет двигателей по фильтру' : `Двигателей: ${rows.length}`,
    columns: preset.columns,
    rows,
    generatedAt: Date.now(),
  };
}

