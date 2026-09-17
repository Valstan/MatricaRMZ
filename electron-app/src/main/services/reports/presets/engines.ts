import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  STATUS_CODES,
  isEavFlagSet,
  computeObjectProgress,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  ENGINE_INVENTORY_STAGE,
  StockMovementType,
  humanLabel,
  pickHumanText,
  extractBomLineNormPercent,
  formatEngineInternalNumber,
  normalizeEngineInventoryRow,
  REPLENISHMENT_BRANCH_REPORT_LABELS,
  selectScrapReportColumns,
  } from '@matricarmz/shared';


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

import { resolveContractLabel, toNumber, normalizeText, asArray, asNumberOrNull, readPeriod, msToDate, stageLabel, stageProgressFallback } from '../format.js';
import { getWarehouseLocationsForReport, getPreset, loadSnapshot, getIdsByType, buildContractCounterpartyIndex, resolveEngineCounterpartyId, buildBrandFilterMatcher, resolveEngineBrandRef, type ReportBuildContext, type Snapshot } from '../context.js';
import {
  buildOptions,
  buildCounterpartyOptions,
  resolveCounterpartyLabel,
  relatedEntityLabel,
  UNKNOWN_ENTITY_LABEL,
  UNKNOWN_ENGINE_NUMBER_LABEL,
  BRAND_MISSING,
} from '../options.js';

// Оператору в этих колонках нельзя показывать идентификатор: у двигателя нет ни
// serial_number, ни name (таких атрибутов не заводит никто), поэтому прежние фолбэки
// на engineId печатали в «№ двигателя» и «Марка» голый UUID.


// Внутренний номер сюда НЕ подставляем: он живёт в соседней колонке «Внутр. №», и
// оператор получил бы одно и то же значение дважды, приняв заводское клеймо за номер
// двигателя.
function engineNumberLabel(attrs: Record<string, unknown>): string {
  return pickHumanText(attrs.engine_number) || UNKNOWN_ENGINE_NUMBER_LABEL;
}

// Марку читаем из снимка, а не из карты опций фильтра: у опции своя подпись отсутствия
// («(без названия)»), и, протекая в колонку, она давала на одну и ту же безымянную марку
// два разных текста в разных разрезах отчёта.
function engineBrandLabel(snapshot: Snapshot, attrs: Record<string, unknown>, brandId: string): string {
  return pickHumanText(relatedEntityLabel(snapshot, brandId), attrs.engine_brand) || BRAND_MISSING;
}

export async function buildEngineStagesReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const contractFilter = asArray(filters?.contractIds);
  const brandFilter = asArray(filters?.brandIds);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const snapshot = await loadSnapshot(db);
  const contractCounterpartyById = buildContractCounterpartyIndex(snapshot);
  const brandMatches = buildBrandFilterMatcher(brandFilter, new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const)));
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
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const engineId of getIdsByType(snapshot, 'engine')) {
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const latest = latestByEngine.get(engineId);
    // Двигатели без единой операции раньше выпадали из отчёта целиком, и на
    // проде, где старые типы операций никто не пишет, отчёт был почти пуст.
    // Стадия и прогресс считаются из статусов карточки; операции — только
    // уточнение «когда было последнее движение». Явный период по-прежнему
    // отбирает по дате последней операции (у кого её нет — не попадает).
    if (period.startMs != null && (!latest || latest.ts < period.startMs)) continue;
    const contractId = normalizeText(attrs.contract_id, '');
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const counterpartyId = resolveEngineCounterpartyId(attrs, contractCounterpartyById);
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
    if (!brandMatches(resolveEngineBrandRef(attrs))) continue;
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
    for (const code of STATUS_CODES) statusFlags[code] = isEavFlagSet(attrs[code]);
    const calculated = computeObjectProgress(statusFlags);
    const progressPct = calculated > 0 ? calculated : latest ? stageProgressFallback(latest.stage) : 0;
    const statusStage = statusFlags.status_customer_sent || statusFlags.status_customer_accepted
      ? 'Отгружен'
      : statusFlags.status_rework_sent || statusFlags.status_scrap_confirmed
        ? 'Утиль'
        : statusFlags.status_repaired
          ? 'Отремонтирован'
          : statusFlags.status_repair_started
            ? 'В ремонте'
            : statusFlags.status_storage_received
              ? 'Принят на хранение'
              : 'Заведён';
    const engineInternalNumber = formatEngineInternalNumber(
      normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
      attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
    );
    rows.push({
      engineNumber: engineNumberLabel(attrs),
      engineInternalNumber,
      engineBrand: engineBrandLabel(snapshot, attrs, brandId),
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      currentStage: latest ? stageLabel(latest.stage) : statusStage,
      progressPct,
      arrivalDate: asNumberOrNull(attrs.acceptance_at ?? attrs.arrival_date),
      lastOperationAt: latest ? latest.ts : null,
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
  const contractCounterpartyById = buildContractCounterpartyIndex(snapshot);
  const brandMatches = buildBrandFilterMatcher(brandFilter, new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const)));
  const engineTypeId = snapshot.entityTypeIdByCode.get('engine');
  if (!engineTypeId) return { ok: false, error: 'Тип сущности "engine" не найден' };
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));

  // ВСЕ дефектовки каждого двигателя (каждая операция engine_inventory — свой акт;
  // «только последняя» занижала охват при повторных заездах — дефект аудита 2026-07-22).
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
  const opsByEngine = new Map<string, Array<{ metaJson: string | null; ts: number }>>();
  for (const op of opRows as any[]) {
    const engineId = String(op?.engineEntityId ?? '').trim();
    if (!engineId) continue;
    const list = opsByEngine.get(engineId) ?? [];
    list.push({
      metaJson: op.metaJson == null ? null : String(op.metaJson),
      ts: Number(op.performedAt ?? op.updatedAt ?? op.createdAt ?? 0),
    });
    opsByEngine.set(engineId, list);
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
    const counterpartyId = resolveEngineCounterpartyId(attrs, contractCounterpartyById);
    const internal = formatEngineInternalNumber(
      normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
      attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
    );
    const engineNumber = engineNumberLabel(attrs);
    let pass = true;
    if (!brandMatches(resolveEngineBrandRef(attrs))) pass = false;
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) pass = false;
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) pass = false;
    return {
      ctx: {
        engineNumber,
        engineInternalNumber: internal,
        engineBrand: engineBrandLabel(snapshot, attrs, brandId),
        contractLabel: resolveContractLabel(contractId, contractOptions),
        counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      },
      pass,
      // Поиск отдельно от показа: в колонку идёт человеческая подпись, а искать по
      // хвосту идентификатора оператор мог и раньше — этого не отнимаем.
      haystack: `${engineNumber} ${internal} ${id}`.toLowerCase(),
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
        // Строка-двигатель участвует в итоге «Утиль, шт.» наравне с деталями
        // (раньше не инкрементила totalScrapQty — итог занижался).
        totalScrapQty += 1;
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

    // Детали из всех дефектовок двигателя (каждый повторный заезд — свой акт).
    if (kindFilter === 'engines') continue;
    for (const op of opsByEngine.get(id) ?? []) {
      if (!op.metaJson) continue;
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
  const locByUuid = await getWarehouseLocationsForReport(db, ctx);
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
  const brandMatches = buildBrandFilterMatcher(brandFilter, new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const)));
  const brandKitCache = new Map<string, { bomName: string; kitLines: BomKitLine[] }>();
  const engineRows = Array.from(snapshot.entitiesById.values()).filter((e) => e.typeId === engineTypeId);
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const engine of engineRows) {
    const attrs = snapshot.attrsByEntity.get(engine.id) ?? {};
    const brandId = String(attrs.engine_brand_id ?? '').trim();
    if (!brandMatches(resolveEngineBrandRef(attrs))) continue;
    const phase = String(attrs.engine_phase ?? '').trim();
    if (phase && phase !== 'received' && phase !== 'disassembled') continue;
    const engineInternalNumber = formatEngineInternalNumber(
      normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
      attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
    );
    const engineNumber = engineNumberLabel(attrs);
    const brandLabel = brandId ? relatedEntityLabel(snapshot, brandId) || BRAND_MISSING : '';

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
          name: pickHumanText(slot.primary.name, slot.primary.code) || UNKNOWN_ENTITY_LABEL,
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
      enginePhase: humanLabel('engine_phase', phase),
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
  /**
   * Ключ вариантной позиции. Машинный: редактор BOM генерирует его сам (`pos-` + случайные
   * знаки). Годен ТОЛЬКО чтобы схлопывать варианты в одну позицию — оператору не показывается.
   */
  group: string;
  /** Подпись позиции, набранная оператором в редакторе BOM. Пустая — значит подписи нет. */
  groupLabel: string;
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
            groupLabel: normalizeText(l.positionLabel, ''),
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
          // Как и онлайн-путь: позиция важнее комплекта, основной вариант — из колонки реплики (E4, план bom-simplify §4).
          group: normalizeText(l.positionKey, '') || normalizeText(l.variantGroup, ''),
          groupLabel: normalizeText(l.positionLabel, ''),
          isRequired: Boolean(l.isRequired),
          priority: Number(l.priority ?? 100),
          isDefaultOption: l.isDefaultOption !== false && l.isDefaultOption !== 0,
          notes: normalizeText(l.notes, ''),
          normPercent: extractBomLineNormPercent(l.notes == null ? null : String(l.notes)),
        };
      });
    }
  }
  return { bomName, kitLines };
}

/**
 * Вариантные позиции BOM: строки без группы — сами по себе; группы — одна позиция
 * (основной вариант + альтернативы).
 *
 * Схлопывание держится на `group` (машинный ключ позиции), а наружу отдаётся ещё и
 * `variantGroupLabel` — подпись оператора. Разделять их обязательно: две разные позиции
 * оператор вправе назвать одинаково, и склейка по подписи слила бы их в одну строку.
 */
function collapseBomKitSlots(kitLines: BomKitLine[]): Array<{
  primary: BomKitLine;
  alternatives: BomKitLine[];
  variantGroup: string;
  variantGroupLabel: string;
  isRequired: boolean;
}> {
  const slots: Array<{
    primary: BomKitLine;
    alternatives: BomKitLine[];
    variantGroup: string;
    variantGroupLabel: string;
    isRequired: boolean;
  }> = [];
  const byGroup = new Map<string, BomKitLine[]>();
  for (const line of kitLines) {
    if (!line.group) {
      slots.push({ primary: line, alternatives: [], variantGroup: '', variantGroupLabel: '', isRequired: line.isRequired });
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
      // Подпись хранится на каждой строке позиции; берём первую непустую — редактор держит
      // их синхронно, но пустая у одного из вариантов не должна обнулять подпись позиции.
      variantGroupLabel: ordered.find((l) => l.groupLabel)?.groupLabel ?? '',
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
  const engineInternalNumber = formatEngineInternalNumber(
    normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
    attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
  );
  const engineNumber = engineNumberLabel(attrs);
  const brandId = normalizeText(attrs.engine_brand_id, '');
  if (!brandId) return empty(`Двигатель №${engineNumber}: марка не указана — BOM не определить`);
  const brandLabel = relatedEntityLabel(snapshot, brandId) || BRAND_MISSING;

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
  const locByUuid = await getWarehouseLocationsForReport(db, ctx);
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
    bins.push({ label: pickHumanText(loc?.name) || UNKNOWN_ENTITY_LABEL, qty: avail });
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
    const alternatives = slot.alternatives.map((l) => pickHumanText(l.name, l.code) || UNKNOWN_ENTITY_LABEL);
    const noteParts = [
      // Подпись позиции, а НЕ `slot.variantGroup`: там машинный ключ редактора BOM
      // (`pos-x7k2m9q`), и оператор читал его вместо «Поршневая группа». Подписи нет —
      // не пишем ничего: ключ подписью не притворяется.
      slot.variantGroupLabel ? `вариант: ${slot.variantGroupLabel}` : '',
      alternatives.length > 0 ? `или: ${alternatives.join(', ')}` : '',
      slot.isRequired ? '' : 'опционально',
      slot.primary.notes,
    ].filter(Boolean);

    rows.push({
      componentName: pickHumanText(slot.primary.name, slot.primary.code) || UNKNOWN_ENTITY_LABEL,
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
  const engineNumberPart = engineNumber === UNKNOWN_ENGINE_NUMBER_LABEL ? UNKNOWN_ENGINE_NUMBER_LABEL : `№${engineNumber}`;
  const engineLabel = [engineNumberPart, engineInternalNumber ? `внутр. ${engineInternalNumber}` : '', brandLabel]
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


type RepairNormReportLine = {
  nomenclatureId: string;
  name: string;
  code: string;
  qtyPerEngine: number;
  replacementPercent: number;
  groupName: string;
};

async function loadRepairNormSetForBrand(
  ctx: ReportBuildContext | undefined,
  brandId: string,
): Promise<{ setName: string; setVersion: number; lines: RepairNormReportLine[] }> {
  const apiBase = String(ctx?.apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!ctx?.sysDb || !apiBase) return { setName: '', setVersion: 0, lines: [] };
  try {
    const listRes = await httpAuthed(
      ctx.sysDb,
      apiBase,
      `/warehouse/repair-norms?engineBrandId=${encodeURIComponent(brandId)}&status=active`,
      { method: 'GET' },
      { timeoutMs: 15_000 },
    );
    const listJson = listRes.ok && listRes.json && typeof listRes.json === 'object'
      ? (listRes.json as Record<string, unknown>)
      : null;
    const sets = listJson?.ok === true && Array.isArray(listJson.rows)
      ? (listJson.rows as Array<Record<string, unknown>>)
      : [];
    const selected = [...sets].sort(
      (a, b) => Number(b.version ?? 0) - Number(a.version ?? 0) || Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0),
    )[0];
    if (!selected?.id) return { setName: '', setVersion: 0, lines: [] };
    const detailsRes = await httpAuthed(
      ctx.sysDb,
      apiBase,
      `/warehouse/repair-norms/${encodeURIComponent(String(selected.id))}`,
      { method: 'GET' },
      { timeoutMs: 15_000 },
    );
    const detailsJson = detailsRes.ok && detailsRes.json && typeof detailsRes.json === 'object'
      ? (detailsRes.json as Record<string, unknown>)
      : null;
    const normSet = detailsJson?.ok === true && detailsJson.normSet && typeof detailsJson.normSet === 'object'
      ? (detailsJson.normSet as Record<string, unknown>)
      : null;
    const lines = Array.isArray(normSet?.lines) ? (normSet.lines as Array<Record<string, unknown>>) : [];
    return {
      setName: normalizeText(normSet?.name, normalizeText(selected.name, '')),
      setVersion: Math.max(1, Math.trunc(Number(normSet?.version ?? selected.version ?? 1))),
      lines: lines
        .map((line) => ({
          nomenclatureId: String(line.nomenclatureId ?? ''),
          name: normalizeText(line.nomenclatureName, ''),
          code: normalizeText(line.nomenclatureCode, ''),
          qtyPerEngine: Math.max(0, Number(line.qtyPerEngine ?? 0)),
          replacementPercent: Math.max(0, Math.min(100, Number(line.replacementPercent ?? 0))),
          groupName: normalizeText(line.groupName, ''),
        }))
        .filter((line) => line.nomenclatureId && line.qtyPerEngine > 0),
    };
  } catch {
    return { setName: '', setVersion: 0, lines: [] };
  }
}

/**
 * «План закупок по нормам»: отдельный реестр норм ремонта × количество двигателей;
 * BOM здесь намеренно не используется — он описывает комплект сборки, а не статистику замены.
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
  const brandLabel = relatedEntityLabel(snapshot, brandId) || BRAND_MISSING;
  const { setName, setVersion, lines: normLines } = await loadRepairNormSetForBrand(ctx, brandId);
  if (normLines.length === 0) {
    return empty(`Марка «${brandLabel}»: активный набор норм ремонта не найден или сервер недоступен`);
  }

  // Свободные остатки (qty − reserved) без технических локаций; ремфонд — отдельной колонкой.
  const locByUuid = await getWarehouseLocationsForReport(db, ctx);
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

  const rows: Array<Record<string, ReportCellValue>> = [];
  let totalPlanQty = 0;
  let totalToPurchaseQty = 0;
  for (const line of normLines) {
    const planQty = Math.ceil((line.qtyPerEngine * enginesCount * line.replacementPercent) / 100);
    const availableQty = availableByNom.get(line.nomenclatureId) ?? 0;
    const repairFundQty = repairFundByNom.get(line.nomenclatureId) ?? 0;
    const toPurchaseQty = Math.max(0, planQty - availableQty);
    totalPlanQty += planQty;
    totalToPurchaseQty += toPurchaseQty;
    if (onlyToPurchase && toPurchaseQty <= 0) continue;
    rows.push({
      componentName: pickHumanText(line.name, line.code) || UNKNOWN_ENTITY_LABEL,
      componentCode: line.code,
      qtyPerUnit: line.qtyPerEngine,
      normPercentLabel: String(line.replacementPercent),
      planQty,
      availableQty,
      repairFundQty,
      toPurchaseQty,
      variantNote: line.groupName,
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
    subtitle: `${brandLabel} · нормы «${setName}» v${setVersion} · двигателей: ${enginesCount}`,
    columns: preset.columns,
    rows,
    totals: { totalPlanQty, totalToPurchaseQty, positionsWithoutNorm: 0 },
    generatedAt: Date.now(),
  };
}
