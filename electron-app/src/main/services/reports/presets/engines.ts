import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  STATUS_CODES,
  computeObjectProgress,
  isScrapEngine,
  effectiveContractDueAt,
  parseContractSections,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  type StatusCode,
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  ENGINE_INVENTORY_STAGE,
  StockMovementType,
  extractBomLineNormPercent,
  formatEngineInternalNumber,
  normalizeEngineInventoryRow,
  REPLENISHMENT_BRANCH_REPORT_LABELS,
  selectEnginesListReportColumns,
  selectEnginesContractsEngineColumns,
  ENGINES_CONTRACTS_CONTRACT_COLUMNS,
  ENGINES_CONTRACTS_BRAND_COLUMNS,
  selectScrapReportColumns,
  } from '@matricarmz/shared';

import { collectContractEngineQty } from './contracts.js';

import {
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
  operations,
} from '../../../database/schema.js';



import { httpAuthed } from '../../httpClient.js';
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
  const repairActiveFilter = normalizeText(filters?.repairActiveFilter, 'all');
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

    const repairActive =
      attrs.status_repair_started === true || attrs.status_repair_started === 'true' || attrs.status_repair_started === 1;
    if (repairActiveFilter === 'yes' && !repairActive) continue;
    if (repairActiveFilter === 'no' && repairActive) continue;

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
      scrapReason: normalizeText(attrs.scrap_reason, ''),
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


const MS_PER_DAY = 24 * 60 * 60 * 1000;

type EngineOverviewAgg = {
  arrived: number;
  atFactory: number;
  shipped: number;
  readyNotShipped: number;
  scrap: number;
  tatSum: number;
  tatCount: number;
};

function emptyOverviewAgg(): EngineOverviewAgg {
  return { arrived: 0, atFactory: 0, shipped: 0, readyNotShipped: 0, scrap: 0, tatSum: 0, tatCount: 0 };
}

type EngineOverviewRec = {
  contractId: string;
  brandId: string;
  onFactory: boolean;
  leftFactory: boolean;
  readyNotShipped: boolean;
  scrap: boolean;
  tat: number | null;
  aging: number | null;
  shippingDate: number | null;
};

function accIntoOverviewAgg(map: Map<string, EngineOverviewAgg>, key: string, rec: EngineOverviewRec): void {
  const agg = map.get(key) ?? emptyOverviewAgg();
  agg.arrived += 1;
  if (rec.onFactory) agg.atFactory += 1;
  if (rec.leftFactory) agg.shipped += 1;
  if (rec.readyNotShipped) agg.readyNotShipped += 1;
  if (rec.scrap) agg.scrap += 1;
  if (rec.tat != null) {
    agg.tatSum += rec.tat;
    agg.tatCount += 1;
  }
  map.set(key, agg);
}

/**
 * Отчёт «Двигатели и контракты» — единый разносторонний обзор с переключателем разреза
 * (по контрактам / по маркам / по двигателям). Статусы двигателя не пересчитываются —
 * переиспользуется каноническая resolveEngineShippingState + isScrapEngine. «Покинул завод»
 * = отгружен заказчику (customer_sent/accepted) ЛИБО возвращён как утиль (status_rework_sent);
 * «на заводе» = всё остальное. «Приехало» = число заведённых двигателей контракта; «план» —
 * сумма марок в contract_sections (collectContractEngineQty, с fallback на engine_count_total).
 */
export async function buildEnginesContractsOverviewReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const periodBasis = normalizeText(filters?.periodBasis, 'none');
  const usePeriod = periodBasis === 'arrival' || periodBasis === 'shipping';
  const brandFilter = asArray(filters?.brandIds);
  const contractFilter = asArray(filters?.contractIds);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const engineState = normalizeText(filters?.engineState, 'all');
  const hideScrap = filters?.hideScrap === true;
  const overdueOnly = filters?.overdueOnly === true;
  const agingDays = Math.max(0, toNumber(filters?.agingDays));
  const groupBy = normalizeText(filters?.groupBy, 'contracts');
  const columnKeys = asArray(filters?.columns);

  const snapshot = await loadSnapshot(db);
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));

  // Провенанс контрактов: план / срок / заказчик заранее — используется и разрезом
  // «По контрактам», и метрикой «в срок» (on-time) для всех разрезов.
  const contractPlanById = new Map<string, number>();
  const contractDueAtById = new Map<string, number | null>();
  const contractCounterpartyById = new Map<string, string>();
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const sections = parseContractSections(attrs);
    contractPlanById.set(contractId, collectContractEngineQty(attrs));
    contractDueAtById.set(contractId, effectiveContractDueAt(sections) ?? asNumberOrNull(attrs.due_date));
    contractCounterpartyById.set(contractId, normalizeText(sections.primary.customerId ?? attrs.customer_id, ''));
  }

  const now = Date.now();
  const byContract = new Map<string, EngineOverviewAgg>();
  const byBrand = new Map<string, EngineOverviewAgg>();
  const engineRows: Array<Record<string, ReportCellValue>> = [];
  let engOnSite = 0;
  let engScrap = 0;
  let globalTatSum = 0;
  let globalTatCount = 0;
  let onTimeEligible = 0;
  let onTimeMet = 0;

  for (const engineId of getIdsByType(snapshot, 'engine')) {
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const contractId = normalizeText(attrs.contract_id, '');
    const counterpartyId = normalizeText(attrs.counterparty_id ?? attrs.customer_id, '');

    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;

    const statusFlags: Partial<Record<StatusCode, boolean>> = {};
    for (const code of STATUS_CODES) statusFlags[code] = Boolean(attrs[code]);
    const scrap = isScrapEngine(statusFlags);
    const reworkSent = statusFlags.status_rework_sent === true;
    const repaired = statusFlags.status_repaired === true;
    const { shippingDate, onSite: baseOnSite } = resolveEngineShippingState(attrs);
    // Утиль-возврат (status_rework_sent) resolveEngineShippingState не считает выбытием —
    // для честного «осталось на заводе» добавляем его как выбытие явно.
    const leftFactory = !baseOnSite || reworkSent;
    const onFactory = !leftFactory;
    const readyNotShipped = repaired && onFactory;
    const arrivalRaw = toNumber(attrs.arrival_date);

    if (usePeriod) {
      const basisDate = periodBasis === 'arrival' ? arrivalRaw : shippingDate ?? 0;
      if (!(basisDate > 0)) continue;
      if (period.startMs != null && basisDate < period.startMs) continue;
      if (basisDate > period.endMs) continue;
    }

    if (hideScrap && scrap) continue;
    if (engineState === 'on_site' && !onFactory) continue;
    if (engineState === 'shipped' && !leftFactory) continue;
    if (engineState === 'ready_not_shipped' && !readyNotShipped) continue;
    if (engineState === 'scrap' && !scrap) continue;

    const aging = onFactory && arrivalRaw > 0 ? Math.round((now - arrivalRaw) / MS_PER_DAY) : null;
    if (agingDays > 0 && !(onFactory && aging != null && aging >= agingDays)) continue;

    const tat = leftFactory && shippingDate != null && arrivalRaw > 0 ? Math.round((shippingDate - arrivalRaw) / MS_PER_DAY) : null;
    if (tat != null) {
      globalTatSum += tat;
      globalTatCount += 1;
    }
    if (leftFactory) {
      const dueAt = contractDueAtById.get(contractId) ?? null;
      if (dueAt != null && shippingDate != null) {
        onTimeEligible += 1;
        if (shippingDate <= dueAt) onTimeMet += 1;
      }
    }

    const rec: EngineOverviewRec = {
      contractId,
      brandId,
      onFactory,
      leftFactory,
      readyNotShipped,
      scrap,
      tat,
      aging,
      shippingDate,
    };
    accIntoOverviewAgg(byContract, contractId, rec);
    accIntoOverviewAgg(byBrand, brandId || '(без марки)', rec);

    if (groupBy === 'engines') {
      if (onFactory) engOnSite += 1;
      if (scrap) engScrap += 1;
      const repairStartedRaw = toNumber(attrs.status_repair_started_date);
      const repairedRaw = toNumber(attrs.status_repaired_date);
      const stateLabel = scrap
        ? 'Утиль'
        : leftFactory
          ? 'Отгружен'
          : readyNotShipped
            ? 'Готов, не отгружен'
            : statusFlags.status_repair_started
              ? 'В ремонте'
              : statusFlags.status_storage_received
                ? 'Принят'
                : 'На заводе';
      engineRows.push({
        engineNumber: normalizeText(attrs.engine_number ?? attrs.number, engineId),
        engineInternalNumber: formatEngineInternalNumber(
          normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
          attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
        ),
        engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
        contractLabel: resolveContractLabel(contractId, contractOptions),
        counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
        arrivalDate: arrivalRaw > 0 ? arrivalRaw : null,
        repairStartedDate: repairStartedRaw > 0 ? repairStartedRaw : null,
        repairedDate: repairedRaw > 0 ? repairedRaw : null,
        shippingDate,
        daysOnSite: leftFactory ? tat : aging,
        stateLabel,
        isScrap: scrap ? 'Да' : 'Нет',
      });
    }
  }

  const preset = getPreset('engines_contracts_overview');
  const subtitle =
    periodBasis === 'none'
      ? 'За всё время'
      : `${periodBasis === 'arrival' ? 'Приход' : 'Отгрузка'}: ${msToDate(period.startMs)} — ${msToDate(period.endMs)}`;

  if (groupBy === 'engines') {
    engineRows.sort((a, b) => toNumber(b.arrivalDate) - toNumber(a.arrivalDate));
    return {
      ok: true,
      presetId: 'engines_contracts_overview',
      title: preset.title,
      subtitle,
      columns: selectEnginesContractsEngineColumns(columnKeys),
      rows: engineRows,
      totals: { engines: engineRows.length, onSiteQty: engOnSite, scrapQty: engScrap },
      generatedAt: now,
    };
  }

  if (groupBy === 'brands') {
    const rows: Array<Record<string, ReportCellValue>> = [];
    for (const [brandKey, agg] of byBrand.entries()) {
      rows.push({
        engineBrand: brandOptions.get(brandKey) ?? brandKey,
        arrivedQty: agg.arrived,
        atFactoryQty: agg.atFactory,
        readyNotShippedQty: agg.readyNotShipped,
        shippedQty: agg.shipped,
        scrapQty: agg.scrap,
        avgTatDays: agg.tatCount > 0 ? Math.round(agg.tatSum / agg.tatCount) : null,
      });
    }
    rows.sort((a, b) => toNumber(b.arrivedQty) - toNumber(a.arrivedQty) || String(a.engineBrand ?? '').localeCompare(String(b.engineBrand ?? ''), 'ru'));
    const totals = {
      brands: rows.length,
      arrivedQty: rows.reduce((acc, r) => acc + toNumber(r.arrivedQty), 0),
      onSiteQty: rows.reduce((acc, r) => acc + toNumber(r.atFactoryQty), 0),
      shippedQty: rows.reduce((acc, r) => acc + toNumber(r.shippedQty), 0),
      scrapQty: rows.reduce((acc, r) => acc + toNumber(r.scrapQty), 0),
      avgTatDays: globalTatCount > 0 ? Math.round(globalTatSum / globalTatCount) : 0,
    };
    return {
      ok: true,
      presetId: 'engines_contracts_overview',
      title: preset.title,
      subtitle,
      columns: ENGINES_CONTRACTS_BRAND_COLUMNS,
      rows,
      totals,
      generatedAt: now,
    };
  }

  // groupBy === 'contracts' (по умолчанию)
  const rows: Array<Record<string, ReportCellValue>> = [];
  let backlog = 0;
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    if (contractFilter.length > 0 && !contractFilter.includes(contractId)) continue;
    const counterpartyId = contractCounterpartyById.get(contractId) ?? '';
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const plan = contractPlanById.get(contractId) ?? 0;
    const agg = byContract.get(contractId) ?? emptyOverviewAgg();
    if (plan === 0 && agg.arrived === 0) continue;
    const dueAt = contractDueAtById.get(contractId) ?? null;
    const awaiting = Math.max(0, plan - agg.arrived);
    const progressPct = plan > 0 ? Math.min(100, (agg.shipped / plan) * 100) : agg.arrived > 0 ? (agg.shipped / agg.arrived) * 100 : 0;
    const overdueDays = dueAt != null && dueAt < now && progressPct < 100 ? Math.ceil((now - dueAt) / MS_PER_DAY) : 0;
    if (overdueOnly && overdueDays <= 0) continue;
    backlog += Math.max(0, plan - agg.shipped);
    rows.push({
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      dueAt,
      planQty: plan,
      arrivedQty: agg.arrived,
      awaitingQty: awaiting,
      atFactoryQty: agg.atFactory,
      readyNotShippedQty: agg.readyNotShipped,
      shippedQty: agg.shipped,
      scrapQty: agg.scrap,
      progressPct,
      overdueDays,
    });
  }
  rows.sort(
    (a, b) => toNumber(b.overdueDays) - toNumber(a.overdueDays) || String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru'),
  );
  const totals = {
    contracts: rows.length,
    planQty: rows.reduce((acc, r) => acc + toNumber(r.planQty), 0),
    arrivedQty: rows.reduce((acc, r) => acc + toNumber(r.arrivedQty), 0),
    onSiteQty: rows.reduce((acc, r) => acc + toNumber(r.atFactoryQty), 0),
    shippedQty: rows.reduce((acc, r) => acc + toNumber(r.shippedQty), 0),
    scrapQty: rows.reduce((acc, r) => acc + toNumber(r.scrapQty), 0),
  };
  const totalArrived = totals.arrivedQty;
  const totalShipped = totals.shippedQty;
  const footerNotes = [
    `Незакрытый остаток по контрактам (план − отгружено): ${backlog} дв.`,
    `Средний срок ремонта (TAT, приход → отгрузка): ${globalTatCount > 0 ? Math.round(globalTatSum / globalTatCount) : '—'} дн. (по ${globalTatCount} отгруженным).`,
    `Доля утиля: ${totalArrived > 0 ? ((totals.scrapQty / totalArrived) * 100).toFixed(1) : '0.0'}% (${totals.scrapQty} из ${totalArrived}).`,
    onTimeEligible > 0
      ? `Отгрузка в срок: ${((onTimeMet / onTimeEligible) * 100).toFixed(1)}% (${onTimeMet} из ${onTimeEligible} с заданным сроком).`
      : 'Отгрузка в срок: нет контрактов с заданным сроком среди отгруженных.',
    `Отгружено всего: ${totalShipped} из ${totalArrived} приехавших.`,
  ];

  return {
    ok: true,
    presetId: 'engines_contracts_overview',
    title: preset.title,
    subtitle,
    columns: ENGINES_CONTRACTS_CONTRACT_COLUMNS,
    rows,
    totals,
    footerNotes,
    generatedAt: now,
  };
}


/**
 * Отчёт «Утиль: реестр с причинами» (scrap-transparency 2026-07): все утильные
 * позиции — строки дефектовок с scrap_qty>0 (последняя дефектовка каждого
 * двигателя, как getCompletenessActStartedMap) + двигатели с утильными статусами
 * (status_scrap_confirmed / status_rework_sent).
 */
export async function buildScrapRegisterReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const brandFilter = asArray(filters?.brandIds);
  const contractFilter = asArray(filters?.contractIds);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const engineQuery = normalizeText(filters?.engineNumberQuery, '').trim().toLowerCase();
  const branchFilter = normalizeText(filters?.branchFilter, 'all');
  const kindFilter = normalizeText(filters?.kindFilter, 'all');
  const columnKeys = asArray(filters?.columns);

  const snapshot = await loadSnapshot(db);
  const engineTypeId = snapshot.entityTypeIdByCode.get('engine');
  if (!engineTypeId) return { ok: false, error: 'Тип сущности "engine" не найден' };
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));

  // Последняя дефектовка каждого двигателя (свежайшая операция стадии engine_inventory).
  const opRows = await db
    .select({
      engineEntityId: operations.engineEntityId,
      metaJson: operations.metaJson,
      performedAt: operations.performedAt,
      createdAt: operations.createdAt,
      updatedAt: operations.updatedAt,
    })
    .from(operations)
    .where(and(eq(operations.operationType, ENGINE_INVENTORY_STAGE), isNull(operations.deletedAt)))
    .orderBy(desc(operations.updatedAt));
  const latestOpByEngine = new Map<string, { metaJson: string | null; ts: number }>();
  for (const op of opRows as any[]) {
    const engineId = String(op?.engineEntityId ?? '').trim();
    if (!engineId || latestOpByEngine.has(engineId)) continue;
    latestOpByEngine.set(engineId, {
      metaJson: op.metaJson == null ? null : String(op.metaJson),
      ts: Number(op.performedAt ?? op.updatedAt ?? op.createdAt ?? 0),
    });
  }

  type EngineCtx = {
    engineNumber: string;
    engineInternalNumber: string;
    engineBrand: string;
    contractLabel: string;
    counterpartyLabel: string;
  };
  const engineCtx = (attrs: Record<string, unknown>, id: string): { ctx: EngineCtx; pass: boolean; haystack: string } => {
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const contractId = normalizeText(attrs.contract_id, '');
    const counterpartyId = normalizeText(attrs.counterparty_id ?? attrs.customer_id, '');
    const engineNumber = normalizeText(attrs.engine_number ?? attrs.number, id);
    const internal = formatEngineInternalNumber(
      normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
      attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
    );
    let pass = true;
    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) pass = false;
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) pass = false;
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) pass = false;
    return {
      ctx: {
        engineNumber,
        engineInternalNumber: internal,
        engineBrand: brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId),
        contractLabel: resolveContractLabel(contractId, contractOptions),
        counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      },
      pass,
      haystack: `${engineNumber} ${internal}`.toLowerCase(),
    };
  };

  const rows: Array<Record<string, ReportCellValue>> = [];
  let totalScrapQty = 0;
  const branchTotals: Record<string, number> = { customer: 0, repair: 0, purchase: 0, none: 0 };

  for (const [id, entity] of snapshot.entitiesById.entries()) {
    if (entity.typeId !== engineTypeId) continue;
    const attrs = snapshot.attrsByEntity.get(id) ?? {};
    const { ctx, pass, haystack } = engineCtx(attrs, id);
    if (!pass) continue;
    if (engineQuery && !haystack.includes(engineQuery)) continue;

    // Двигатель целиком.
    const scrapConfirmed = attrs.status_scrap_confirmed === true || attrs.status_scrap_confirmed === 'true';
    const reworkSent = attrs.status_rework_sent === true || attrs.status_rework_sent === 'true';
    if (kindFilter !== 'parts' && (scrapConfirmed || reworkSent) && branchFilter === 'all') {
      const statusDate = toNumber(attrs.status_rework_sent_date) || toNumber(attrs.status_scrap_confirmed_date);
      const inPeriod =
        (period.startMs == null || statusDate <= 0 || statusDate >= period.startMs) && (statusDate <= 0 || statusDate <= period.endMs);
      if (inPeriod) {
        rows.push({
          rowKind: reworkSent ? 'Двигатель · отправлен заказчику' : 'Двигатель · признан утильным',
          ...ctx,
          partName: 'Двигатель целиком',
          partNumber: '',
          stampedNumber: '',
          scrapQty: 1,
          scrapReason: normalizeText(attrs.scrap_reason, ''),
          replenishmentBranch: '',
          scrapDate: statusDate > 0 ? statusDate : null,
        });
      }
    }

    // Детали из последней дефектовки.
    if (kindFilter === 'engines') continue;
    const op = latestOpByEngine.get(id);
    if (!op?.metaJson) continue;
    let rawRows: Array<Record<string, unknown>> = [];
    try {
      const payload = JSON.parse(op.metaJson);
      const table = payload?.answers?.engine_inventory_items;
      rawRows = table?.kind === 'table' && Array.isArray(table.rows) ? table.rows : [];
    } catch {
      rawRows = [];
    }
    if (period.startMs != null && op.ts > 0 && op.ts < period.startMs) continue;
    if (op.ts > 0 && op.ts > period.endMs) continue;
    for (const raw of rawRows) {
      const { row } = normalizeEngineInventoryRow(raw);
      if (row.scrap_qty <= 0) continue;
      const branchKey = row.replenishment_branch ?? 'none';
      if (branchFilter !== 'all' && branchKey !== branchFilter) continue;
      totalScrapQty += row.scrap_qty;
      branchTotals[branchKey] = (branchTotals[branchKey] ?? 0) + row.scrap_qty;
      rows.push({
        rowKind: 'Деталь',
        ...ctx,
        partName: row.part_name,
        partNumber: row.part_number,
        stampedNumber: row.stamped_number ?? '',
        scrapQty: row.scrap_qty,
        scrapReason: row.scrap_reason ?? '',
        replenishmentBranch: row.replenishment_branch ? (REPLENISHMENT_BRANCH_REPORT_LABELS[row.replenishment_branch] ?? row.replenishment_branch) : '',
        scrapDate: op.ts > 0 ? op.ts : null,
      });
    }
  }

  rows.sort((a, b) => toNumber(b.scrapDate) - toNumber(a.scrapDate));

  const preset = getPreset('scrap_register');
  return {
    ok: true,
    presetId: 'scrap_register',
    title: preset.title,
    subtitle: period.startMs ? `${msToDate(period.startMs)} — ${msToDate(period.endMs)}` : `по ${msToDate(period.endMs)}`,
    columns: selectScrapReportColumns(columnKeys),
    rows,
    totals: {
      positions: rows.length,
      scrapQty: totalScrapQty,
      customerQty: branchTotals.customer ?? 0,
      repairQty: branchTotals.repair ?? 0,
      purchaseQty: branchTotals.purchase ?? 0,
      noBranchQty: branchTotals.none ?? 0,
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

  // G13: BOM берём через loadBomKitForBrand (REST + офлайн-fallback) — локальные BOM-таблицы
  // на клиентах пусты (не входят в sync), прежний код читал их и показывал 0 компонентов.
  const brandKitCache = new Map<string, { bomName: string; kitLines: BomKitLine[] }>();
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

    let kit = brandId ? brandKitCache.get(brandId) : { bomName: '', kitLines: [] as BomKitLine[] };
    if (!kit) {
      kit = await loadBomKitForBrand(db, ctx, brandId);
      brandKitCache.set(brandId, kit);
    }
    const slots = collapseBomKitSlots(kit.kitLines).filter((s) => s.primary.qty > 0);
    const totalComponents = slots.length;
    const shortages: Array<{ name: string; need: number; have: number }> = [];
    for (const slot of slots) {
      const need = slot.primary.qty;
      const nomIds = Array.from(
        new Set([slot.primary, ...slot.alternatives].map((l) => l.nomenclatureId).filter(Boolean)),
      );
      const have = nomIds.reduce((acc, id) => acc + (stockByNom.get(id) ?? 0), 0);
      if (have < need) {
        shortages.push({
          name: slot.primary.name || slot.primary.code || slot.primary.nomenclatureId.slice(0, 8),
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
      shortageSummary:
        totalComponents === 0
          ? 'BOM не найден (нет связи с сервером или BOM не заведён)'
          : shortages
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

type BomKitLine = {
  nomenclatureId: string;
  name: string;
  code: string;
  qty: number;
  group: string;
  isRequired: boolean;
  priority: number;
  isDefaultOption: boolean;
  notes: string;
  /** Норма расхода, % (G8): типизированное поле либо распарсенный текст примечания. null = не задана. */
  normPercent: number | null;
};

const bomKitRank = (h: { status?: unknown; isDefault?: unknown }) =>
  (h.isDefault ? 2 : 0) + (String(h.status ?? '') === 'active' ? 1 : 0);

/**
 * BOM марки двигателя: сначала REST (клиентские BOM-таблицы НЕ входят в sync-пайплайн и на
 * клиентах пусты — G13), локальная реплика — офлайн-fallback (на случай будущего включения
 * BOM в sync). Пустой kitLines = BOM недоступен (нет связи или не заведён).
 */
async function loadBomKitForBrand(
  db: BetterSQLite3Database,
  ctx: ReportBuildContext | undefined,
  brandId: string,
): Promise<{ bomName: string; kitLines: BomKitLine[] }> {
  let bomName = '';
  let kitLines: BomKitLine[] = [];
  const apiBase = String(ctx?.apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (ctx?.sysDb && apiBase) {
    try {
      const listRes = await httpAuthed(
        ctx.sysDb,
        apiBase,
        `/warehouse/assembly-bom?engineBrandId=${encodeURIComponent(brandId)}`,
        { method: 'GET' },
        { timeoutMs: 15_000 },
      );
      const listJson = listRes.ok && listRes.json && typeof listRes.json === 'object' ? (listRes.json as Record<string, unknown>) : null;
      const headers = listJson?.ok === true && Array.isArray(listJson.rows) ? (listJson.rows as Array<Record<string, unknown>>) : [];
      const best = [...headers].sort((a, b) => bomKitRank(b) - bomKitRank(a) || Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0];
      if (best?.id) {
        const detRes = await httpAuthed(
          ctx.sysDb,
          apiBase,
          `/warehouse/assembly-bom/${encodeURIComponent(String(best.id))}`,
          { method: 'GET' },
          { timeoutMs: 15_000 },
        );
        const detJson = detRes.ok && detRes.json && typeof detRes.json === 'object' ? (detRes.json as Record<string, unknown>) : null;
        const bomObj = detJson?.ok === true && detJson.bom && typeof detJson.bom === 'object' ? (detJson.bom as Record<string, unknown>) : null;
        const header = bomObj?.header && typeof bomObj.header === 'object' ? (bomObj.header as Record<string, unknown>) : null;
        const lines = Array.isArray(bomObj?.lines) ? (bomObj!.lines as Array<Record<string, unknown>>) : [];
        if (header && lines.length > 0) {
          bomName = normalizeText(header.name, String(best.name ?? ''));
          kitLines = lines.map((l) => ({
            nomenclatureId: String(l.componentNomenclatureId ?? ''),
            name: normalizeText(l.componentNomenclatureName, ''),
            code: normalizeText(l.componentNomenclatureCode, ''),
            qty: Math.max(0, Math.floor(Number(l.qtyPerUnit ?? 0))),
            group: normalizeText(l.positionKey, normalizeText(l.variantGroup, '')),
            isRequired: Boolean(l.isRequired),
            priority: Number(l.priority ?? 100),
            isDefaultOption: Boolean(l.isDefaultOption),
            notes: normalizeText(l.notes, ''),
            normPercent:
              Number.isFinite(Number(l.normPercent)) && Number(l.normPercent) > 0
                ? Number(l.normPercent)
                : extractBomLineNormPercent(l.notes == null ? null : String(l.notes)),
          }));
        }
      }
    } catch {
      // REST недоступен — офлайн-fallback ниже.
    }
  }
  if (kitLines.length === 0) {
    const bomHeaders = (await db
      .select({
        id: erpEngineAssemblyBom.id,
        name: erpEngineAssemblyBom.name,
        status: erpEngineAssemblyBom.status,
        isDefault: erpEngineAssemblyBom.isDefault,
        updatedAt: erpEngineAssemblyBom.updatedAt,
      })
      .from(erpEngineAssemblyBom)
      .innerJoin(
        erpEngineAssemblyBomBrandLinks,
        and(
          eq(erpEngineAssemblyBomBrandLinks.bomId, erpEngineAssemblyBom.id),
          eq(erpEngineAssemblyBomBrandLinks.engineBrandId, brandId),
          isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
        ),
      )
      .where(isNull(erpEngineAssemblyBom.deletedAt))) as Array<{
      id: string;
      name: string;
      status: string;
      isDefault: boolean;
      updatedAt: number;
    }>;
    const bom = [...bomHeaders].sort(
      (a, b) => bomKitRank(b) - bomKitRank(a) || Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0),
    )[0];
    if (bom) {
      const bomLines = (await db
        .select()
        .from(erpEngineAssemblyBomLines)
        .where(and(eq(erpEngineAssemblyBomLines.bomId, bom.id), isNull(erpEngineAssemblyBomLines.deletedAt)))) as Array<
        Record<string, unknown>
      >;
      const nomenRows = (await db
        .select({ id: erpNomenclature.id, code: erpNomenclature.code, name: erpNomenclature.name })
        .from(erpNomenclature)) as Array<{ id: string; code: unknown; name: unknown }>;
      const nomenById = new Map<string, { code: string; name: string }>();
      for (const row of nomenRows) nomenById.set(String(row.id), { code: String(row.code ?? ''), name: String(row.name ?? '') });
      bomName = bom.name;
      kitLines = bomLines.map((l) => {
        const nomId = String(l.componentNomenclatureId ?? '');
        const nomen = nomenById.get(nomId);
        return {
          nomenclatureId: nomId,
          name: nomen?.name ?? '',
          code: nomen?.code ?? '',
          qty: Math.max(0, Math.floor(Number(l.qtyPerUnit ?? 0))),
          group: normalizeText(l.variantGroup, ''),
          isRequired: Boolean(l.isRequired),
          priority: Number(l.priority ?? 100),
          isDefaultOption: false,
          notes: normalizeText(l.notes, ''),
          normPercent: extractBomLineNormPercent(l.notes == null ? null : String(l.notes)),
        };
      });
    }
  }
  return { bomName, kitLines };
}

/** Вариантные позиции BOM: строки без группы — сами по себе; группы — одна позиция (основной вариант + альтернативы). */
function collapseBomKitSlots(kitLines: BomKitLine[]): Array<{
  primary: BomKitLine;
  alternatives: BomKitLine[];
  variantGroup: string;
  isRequired: boolean;
}> {
  const slots: Array<{ primary: BomKitLine; alternatives: BomKitLine[]; variantGroup: string; isRequired: boolean }> = [];
  const byGroup = new Map<string, BomKitLine[]>();
  for (const line of kitLines) {
    if (!line.group) {
      slots.push({ primary: line, alternatives: [], variantGroup: '', isRequired: line.isRequired });
      continue;
    }
    const list = byGroup.get(line.group) ?? [];
    list.push(line);
    byGroup.set(line.group, list);
  }
  for (const [group, lines] of byGroup) {
    const ordered = [...lines].sort(
      (a, b) => Number(b.isDefaultOption) - Number(a.isDefaultOption) || a.priority - b.priority,
    );
    slots.push({
      primary: ordered[0]!,
      alternatives: ordered.slice(1),
      variantGroup: group,
      isRequired: ordered.some((l) => l.isRequired),
    });
  }
  return slots;
}

/**
 * «Комплектование двигателя»: BOM марки × выдано в сборку (движения по engineId) ×
 * доступные остатки (без технических локаций) × ремфонд → осталось выдать / дефицит.
 * Вариантные группы BOM схлопываются в одну позицию: требуется по основному варианту,
 * выдано/доступно — суммарно по всем вариантам группы.
 */
export async function buildEngineKittingReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const preset = getPreset('engine_kitting');
  const engineId = String((filters as Record<string, unknown> | undefined)?.engineId ?? '').trim();
  const onlyMissing = Boolean((filters as Record<string, unknown> | undefined)?.onlyMissing);
  const empty = (subtitle: string): ReportPresetPreviewResult => ({
    ok: true,
    presetId: 'engine_kitting',
    title: preset.title,
    subtitle,
    columns: preset.columns,
    rows: [],
    generatedAt: Date.now(),
  });
  if (!engineId) return empty('Выберите двигатель в фильтре');

  const snapshot = await loadSnapshot(db);
  const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
  const engineNumber = normalizeText(attrs.serial_number, normalizeText(attrs.name, engineId.slice(0, 8)));
  const engineInternalNumber = formatEngineInternalNumber(
    normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
    attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
  );
  const brandId = normalizeText(attrs.engine_brand_id, '');
  if (!brandId) return empty(`Двигатель №${engineNumber}: марка не указана — BOM не определить`);
  const brandLabel = normalizeText(snapshot.attrsByEntity.get(brandId)?.name, brandId);

  const { bomName, kitLines } = await loadBomKitForBrand(db, ctx, brandId);
  if (kitLines.length === 0) {
    return empty(`Марка «${brandLabel}»: BOM не найден (нет связи с сервером или BOM не заведён)`);
  }

  // Выдано в сборку на ЭТОТ двигатель: приход на «в сборке» минус возвраты (+ учёт сторно).
  const movementRows = (await db
    .select({
      nomenclatureId: erpRegStockMovements.nomenclatureId,
      movementType: erpRegStockMovements.movementType,
      qty: erpRegStockMovements.qty,
    })
    .from(erpRegStockMovements)
    .where(eq(erpRegStockMovements.engineId, engineId))) as Array<{
    nomenclatureId: string;
    movementType: string;
    qty: number;
  }>;
  const issuedByNom = new Map<string, number>();
  const issuedSign: Record<string, number> = {
    [StockMovementType.AssemblyConsumptionIn]: 1,
    [StockMovementType.AssemblyReturnOut]: -1,
    [`reversal_${StockMovementType.AssemblyConsumptionIn}`]: -1,
    [`reversal_${StockMovementType.AssemblyReturnOut}`]: 1,
  };
  for (const mv of movementRows) {
    const sign = issuedSign[String(mv.movementType ?? '')];
    if (!sign) continue;
    const nomId = String(mv.nomenclatureId ?? '');
    if (!nomId) continue;
    issuedByNom.set(nomId, (issuedByNom.get(nomId) ?? 0) + sign * Number(mv.qty ?? 0));
  }

  // Доступные остатки (qty − reserved) без технических локаций; ремфонд — отдельно.
  const locByUuid = await getWarehouseLocationsById(ctx);
  const balanceRows = (await db.select().from(erpRegStockBalance)) as Array<Record<string, unknown>>;
  const availableByNom = new Map<string, number>();
  const repairFundByNom = new Map<string, number>();
  const binsByNom = new Map<string, Array<{ label: string; qty: number }>>();
  for (const raw of balanceRows) {
    const nomId = String(raw.nomenclatureId ?? '');
    if (!nomId) continue;
    const locId = String(raw.warehouseLocationId ?? '');
    const loc = locByUuid.get(locId);
    const code = loc?.code ?? '';
    if (code === 'scrap' || code === 'assembly_in_progress') continue;
    if (code === 'repair_fund') {
      const qty = Math.max(0, Math.floor(Number(raw.qty ?? 0)));
      if (qty > 0) repairFundByNom.set(nomId, (repairFundByNom.get(nomId) ?? 0) + qty);
      continue;
    }
    const avail = Math.max(0, Math.floor(Number(raw.qty ?? 0) - Number(raw.reservedQty ?? 0)));
    if (avail <= 0) continue;
    availableByNom.set(nomId, (availableByNom.get(nomId) ?? 0) + avail);
    const bins = binsByNom.get(nomId) ?? [];
    bins.push({ label: loc?.name ?? locId.slice(0, 8), qty: avail });
    binsByNom.set(nomId, bins);
  }

  const slots = collapseBomKitSlots(kitLines);

  const rows: Array<Record<string, ReportCellValue>> = [];
  let positionsDone = 0;
  let positionsDeficit = 0;
  let totalDeficitQty = 0;
  for (const slot of slots) {
    const requiredQty = slot.primary.qty;
    if (requiredQty === 0) continue;
    const uniqNomIds = Array.from(
      new Set([slot.primary, ...slot.alternatives].map((l) => l.nomenclatureId).filter(Boolean)),
    );
    const sum = (m: Map<string, number>) => uniqNomIds.reduce((acc, id) => acc + (m.get(id) ?? 0), 0);
    const issuedQty = Math.max(0, sum(issuedByNom));
    const remainingQty = Math.max(0, requiredQty - issuedQty);
    const availableQty = sum(availableByNom);
    const repairFundQty = sum(repairFundByNom);
    const deficitQty = slot.isRequired ? Math.max(0, remainingQty - availableQty) : 0;
    if (remainingQty === 0) positionsDone += 1;
    if (deficitQty > 0) {
      positionsDeficit += 1;
      totalDeficitQty += deficitQty;
    }
    if (onlyMissing && remainingQty === 0) continue;

    const bins = uniqNomIds
      .flatMap((id) => binsByNom.get(id) ?? [])
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 3);
    const alternatives = slot.alternatives
      .map((l) => l.name || l.nomenclatureId.slice(0, 8))
      .filter(Boolean);
    const noteParts = [
      slot.variantGroup ? `вариант: ${slot.variantGroup}` : '',
      alternatives.length > 0 ? `или: ${alternatives.join(', ')}` : '',
      slot.isRequired ? '' : 'опционально',
      slot.primary.notes,
    ].filter(Boolean);

    rows.push({
      componentName: slot.primary.name || slot.primary.nomenclatureId.slice(0, 8),
      componentCode: slot.primary.code,
      requiredQty,
      issuedQty,
      remainingQty,
      availableQty,
      locationsHint: bins.map((b) => `${b.label}: ${b.qty}`).join('; '),
      repairFundQty,
      deficitQty,
      variantNote: noteParts.join(' · '),
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.deficitQty ?? 0) - Number(a.deficitQty ?? 0) ||
      Number(b.remainingQty ?? 0) - Number(a.remainingQty ?? 0) ||
      String(a.componentName ?? '').localeCompare(String(b.componentName ?? ''), 'ru'),
  );

  const totalPositions = slots.filter((s) => s.primary.qty > 0).length;
  const engineLabel = [`№${engineNumber}`, engineInternalNumber ? `внутр. ${engineInternalNumber}` : '', brandLabel]
    .filter(Boolean)
    .join(' · ');
  return {
    ok: true,
    presetId: 'engine_kitting',
    title: preset.title,
    subtitle: `${engineLabel} · BOM «${bomName}» · укомплектовано ${positionsDone}/${totalPositions} позиций`,
    columns: preset.columns,
    rows,
    totals: { totalPositions, positionsDone, positionsDeficit, totalDeficitQty },
    generatedAt: Date.now(),
  };
}


/**
 * «План закупок по нормам» (G8): BOM марки × норма расхода (%) × кол-во двигателей = план;
 * минус свободные остатки (без техлокаций) = к закупке. Норма без типизированного процента
 * считается как 100% (полная замена) — помечается в примечании.
 */
export async function buildNormsPurchasePlanReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const preset = getPreset('norms_purchase_plan');
  const brandId = String((filters as Record<string, unknown> | undefined)?.brandId ?? '').trim();
  const enginesCount = Math.max(1, Math.trunc(Number((filters as Record<string, unknown> | undefined)?.enginesCount ?? 1)));
  const onlyToPurchase = Boolean((filters as Record<string, unknown> | undefined)?.onlyToPurchase);
  const empty = (subtitle: string): ReportPresetPreviewResult => ({
    ok: true,
    presetId: 'norms_purchase_plan',
    title: preset.title,
    subtitle,
    columns: preset.columns,
    rows: [],
    generatedAt: Date.now(),
  });
  if (!brandId) return empty('Выберите марку двигателя в фильтре');

  const snapshot = await loadSnapshot(db);
  const brandLabel = normalizeText(snapshot.attrsByEntity.get(brandId)?.name, brandId);
  const { bomName, kitLines } = await loadBomKitForBrand(db, ctx, brandId);
  if (kitLines.length === 0) {
    return empty(`Марка «${brandLabel}»: BOM не найден (нет связи с сервером или BOM не заведён)`);
  }

  // Свободные остатки (qty − reserved) без технических локаций; ремфонд — отдельной колонкой.
  const locByUuid = await getWarehouseLocationsById(ctx);
  const balanceRows = (await db.select().from(erpRegStockBalance)) as Array<Record<string, unknown>>;
  const availableByNom = new Map<string, number>();
  const repairFundByNom = new Map<string, number>();
  for (const raw of balanceRows) {
    const nomId = String(raw.nomenclatureId ?? '');
    if (!nomId) continue;
    const loc = locByUuid.get(String(raw.warehouseLocationId ?? ''));
    const code = loc?.code ?? '';
    if (code === 'scrap' || code === 'assembly_in_progress') continue;
    if (code === 'repair_fund') {
      const qty = Math.max(0, Math.floor(Number(raw.qty ?? 0)));
      if (qty > 0) repairFundByNom.set(nomId, (repairFundByNom.get(nomId) ?? 0) + qty);
      continue;
    }
    const avail = Math.max(0, Math.floor(Number(raw.qty ?? 0) - Number(raw.reservedQty ?? 0)));
    if (avail > 0) availableByNom.set(nomId, (availableByNom.get(nomId) ?? 0) + avail);
  }

  const slots = collapseBomKitSlots(kitLines);
  const rows: Array<Record<string, ReportCellValue>> = [];
  let totalPlanQty = 0;
  let totalToPurchaseQty = 0;
  let positionsWithoutNorm = 0;
  for (const slot of slots) {
    const qtyPerUnit = slot.primary.qty;
    if (qtyPerUnit <= 0) continue;
    const normPercent = slot.primary.normPercent;
    if (normPercent == null) positionsWithoutNorm += 1;
    const effectivePct = normPercent ?? 100;
    const planQty = Math.ceil((qtyPerUnit * enginesCount * effectivePct) / 100);
    const uniqNomIds = Array.from(
      new Set([slot.primary, ...slot.alternatives].map((l) => l.nomenclatureId).filter(Boolean)),
    );
    const sum = (m: Map<string, number>) => uniqNomIds.reduce((acc, id) => acc + (m.get(id) ?? 0), 0);
    const availableQty = sum(availableByNom);
    const repairFundQty = sum(repairFundByNom);
    const toPurchaseQty = Math.max(0, planQty - availableQty);
    totalPlanQty += planQty;
    totalToPurchaseQty += toPurchaseQty;
    if (onlyToPurchase && toPurchaseQty <= 0) continue;
    const noteParts = [
      normPercent == null ? 'норма не задана — 100%' : '',
      slot.variantGroup ? `вариант: ${slot.variantGroup}` : '',
      slot.isRequired ? '' : 'опционально',
    ].filter(Boolean);
    rows.push({
      componentName: slot.primary.name || slot.primary.nomenclatureId.slice(0, 8),
      componentCode: slot.primary.code,
      qtyPerUnit,
      normPercentLabel: normPercent == null ? '—' : String(normPercent),
      planQty,
      availableQty,
      repairFundQty,
      toPurchaseQty,
      variantNote: noteParts.join(' · '),
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.toPurchaseQty ?? 0) - Number(a.toPurchaseQty ?? 0) ||
      String(a.componentName ?? '').localeCompare(String(b.componentName ?? ''), 'ru'),
  );

  return {
    ok: true,
    presetId: 'norms_purchase_plan',
    title: preset.title,
    subtitle: `${brandLabel} · BOM «${bomName}» · двигателей: ${enginesCount}`,
    columns: preset.columns,
    rows,
    totals: { totalPlanQty, totalToPurchaseQty, positionsWithoutNorm },
    ...(positionsWithoutNorm > 0
      ? { footerNotes: [`Позиций без типизированной нормы: ${positionsWithoutNorm} — посчитаны как 100% замены.`] }
      : {}),
    generatedAt: Date.now(),
  };
}
