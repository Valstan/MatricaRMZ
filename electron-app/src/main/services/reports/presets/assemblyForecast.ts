import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  STATUS_CODES,
  aggregateContractExecutionProgress,
  collectEngineBrandIdsFromContractSections,
  sumEngineBrandQtyByBrandFromContractSections,
  computeObjectProgress,
  effectiveContractDueAt,
  isContractLaggingVsSchedule,
  linearScheduleExpectedProgressPct,
  parseContractExecutionParts,
  parseContractSections,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  assemblyForecastStatusLabelRu,
  } from '@matricarmz/shared';

import {
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  } from '../../../database/schema.js';
import { formatMoscowDate } from '../../../utils/dateUtils.js';
import { httpAuthed } from '../../httpClient.js';



import { formatHttpError, resolveContractLabel, toNumber, normalizeText, asArray, asNumberOrNull, normalizeAssemblyForecastStatusFromApi, entityLabel } from '../format.js';
import { isSqliteMissingEngineBrandIdColumn, isSqliteMissingBomBrandLinksTable, getPreset, loadSnapshot, getIdsByType, type Snapshot, type OkPreview, type ReportBuildContext } from '../context.js';
import { buildOptions, buildCounterpartyOptions, resolveCounterpartyLabel } from '../options.js';

export function contractLagScore(actualPct: number, signedAt: number | null, dueAt: number | null, now: number): number {
  const expected = linearScheduleExpectedProgressPct({ signedAt, dueAt, now });
  if (expected == null) return 0;
  return Math.max(0, expected - actualPct);
}

export async function loadActiveDefaultBomEngineBrandIds(db: BetterSQLite3Database): Promise<Set<string>> {
  try {
    const rows = await db
      .select({ engineBrandId: erpEngineAssemblyBomBrandLinks.engineBrandId })
      .from(erpEngineAssemblyBom)
      .innerJoin(
        erpEngineAssemblyBomBrandLinks,
        and(
          eq(erpEngineAssemblyBomBrandLinks.bomId, erpEngineAssemblyBom.id),
          isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
        ),
      )
      .where(and(eq(erpEngineAssemblyBom.status, 'active'), eq(erpEngineAssemblyBom.isDefault, true), isNull(erpEngineAssemblyBom.deletedAt)));
    return new Set(rows.map((r) => String(r.engineBrandId ?? '').trim()).filter(Boolean));
  } catch (e) {
    if (isSqliteMissingEngineBrandIdColumn(e) || isSqliteMissingBomBrandLinksTable(e)) return new Set();
    throw e;
  }
}

/**
 * @param bomEngineBrandIds `null` — локальный список BOM неизвестен (например, таблицы не заполнены из sync);
 *   тогда марки из контракта не отфильтровываем по локальной SQLite, проверка остаётся на сервере прогноза.
 */
export type ContractBasedAssemblyPriorityResult = {
  priorityEngineBrandIds: string[];
  footerNotes: string[];
  modeHints: string[];
  brandMaxEnginesHorizon?: Record<string, number>;
  /** Двигатели в ремонте, прикреплённые к «горящим» контрактам (для подстановки номеров в строки прогноза в режиме «только на заводе» и для предупреждений). */
  onSiteEnginesByBrand: Map<string, Array<{
    engineId: string;
    engineNumber: string;
    contractId: string;
    contractLabel: string;
    contractScore: number;
  }>>;
  /** Лагающие контракты — для предупреждения «горящие контракты + дефицит запчастей». */
  hotContractsForWarning: Array<{
    contractId: string;
    label: string;
    customerLabel: string;
    daysLeft: number | null;
    actualPct: number;
    brandIds: string[];
    inRepairEngineNumbers: string[];
  }>;
};

export function computeContractBasedAssemblyPriorityFromSnapshot(
  snapshot: Snapshot,
  filters: ReportPresetFilters | undefined,
  bomEngineBrandIds: Set<string> | null,
): ContractBasedAssemblyPriorityResult {
  const now = Date.now();
  const engineBrandFilter = new Set(asArray(filters?.engineBrandIds).map(String));
  const selectedContractIds = new Set(asArray(filters?.assemblyContractIds).map(String).filter(Boolean));
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  type Scored = {
    contractId: string;
    label: string;
    customerLabel: string;
    score: number;
    actualPct: number;
    expected: number | null;
    dueAt: number | null;
    daysLeft: number | null;
    brandIds: string[];
    pendingEngines: number;
  };
  const scored: Scored[] = [];
  const mismatchNotes: string[] = [];
  const missingBomBrandLabels = new Map<string, string>();

  for (const contractId of getIdsByType(snapshot, 'contract')) {
    if (selectedContractIds.size > 0 && !selectedContractIds.has(contractId)) continue;
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const st = normalizeText(attrs.status, '').toLowerCase();
    if (st === 'fulfilled_full' || st === 'fulfilled_partial') continue;

    const sections = parseContractSections(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    const dueAt = effectiveContractDueAt(sections) ?? asNumberOrNull(attrs.due_date);
    /** Просроченные контракты в приоритете не участвуют. */
    if (dueAt != null && now > dueAt) continue;

    const executionParts = parseContractExecutionParts(attrs);

    const engineItems: Array<{ statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> }> = [];
    let pendingEngines = 0;
    for (const engineId of getIdsByType(snapshot, 'engine')) {
      const eattrs = snapshot.attrsByEntity.get(engineId) ?? {};
      if (normalizeText(eattrs.contract_id, '') !== contractId) continue;
      const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
      for (const code of STATUS_CODES) statusFlags[code] = Boolean(eattrs[code]);
      engineItems.push({ statusFlags });
      if (computeObjectProgress(statusFlags) < 99.5) pendingEngines++;
    }

    const agg = aggregateContractExecutionProgress({ sections, engineItems, executionParts });
    const actualPct = Math.min(100, Math.max(0, Number(agg.progressPct ?? 0)));

    if (!isContractLaggingVsSchedule({ actualProgressPct: actualPct, signedAt, dueAt, now })) continue;

    const brandIdsAll = collectEngineBrandIdsFromContractSections(sections);
    if (brandIdsAll.length === 0) continue;

    const brandIdsFiltered = brandIdsAll.filter((id: string) => engineBrandFilter.size === 0 || engineBrandFilter.has(id));
    const label = resolveContractLabel(contractId, contractOptions);
    if (brandIdsFiltered.length === 0) {
      mismatchNotes.push(
        `Контракт «${label}» отстаёт от графика, но марки из контракта не пересекаются с выбранным фильтром марок BOM — расширьте список марок или снимите фильтр.`,
      );
      continue;
    }

    const bomSet = bomEngineBrandIds;
    const inBom =
      bomSet == null ? brandIdsFiltered : brandIdsFiltered.filter((id) => bomSet.has(id));
    const missingBom = bomSet == null ? [] : brandIdsFiltered.filter((id) => !bomSet.has(id));
    for (const id of missingBom) {
      const lab = entityLabel(snapshot.attrsByEntity.get(id), id).trim() || id;
      missingBomBrandLabels.set(id, lab);
    }

    if (inBom.length === 0) {
      mismatchNotes.push(
        `Контракт «${label}» отстаёт, но по маркам ${missingBom.map((id) => missingBomBrandLabels.get(id) ?? '—').join(', ')} нет активной спецификации BOM — строки прогноза сборки для них построить нельзя (заказ по контракту всё равно требует обеспечения).`,
      );
      continue;
    }

    const expected = linearScheduleExpectedProgressPct({ signedAt, dueAt, now });
    const score = contractLagScore(actualPct, signedAt, dueAt, now);
    const daysLeft = dueAt != null ? Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000)) : null;
    const customerId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    const customerLabel = resolveCounterpartyLabel(snapshot, counterpartyOptions, customerId);

    scored.push({
      contractId,
      label,
      customerLabel,
      score,
      actualPct,
      expected,
      dueAt,
      daysLeft,
      brandIds: inBom,
      pendingEngines,
    });
  }

  scored.sort((a, b) => b.score - a.score || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));

  let priorityEngineBrandIds: string[] = [];
  const seen = new Set<string>();
  for (const row of scored) {
    for (const bid of row.brandIds) {
      if (seen.has(bid)) continue;
      seen.add(bid);
      priorityEngineBrandIds.push(bid);
    }
  }

  const brandMaxMap = new Map<string, number>();
  const volumeModeHints: string[] = [];
  const onSiteOnly = Boolean(filters?.assemblyForecastOnSiteOnly);
  const onSiteEnginesByBrand = new Map<string, Array<{
    engineId: string;
    engineNumber: string;
    contractId: string;
    contractLabel: string;
    contractScore: number;
  }>>();
  const hotContractsForWarning: ContractBasedAssemblyPriorityResult['hotContractsForWarning'] = [];
  if (scored.length > 0) {
    const scoredContractIds = new Set(scored.map((s) => s.contractId));
    const scoredByContractId = new Map(scored.map((s) => [s.contractId, s] as const));
    const passesBrandAndBom = (bid: string) => {
      if (!bid) return false;
      if (engineBrandFilter.size > 0 && !engineBrandFilter.has(bid)) return false;
      if (bomEngineBrandIds != null && !bomEngineBrandIds.has(bid)) return false;
      return true;
    };

    /**
     * Сбор двигателей в ремонте под «горящими» контрактами — нужно и для onSiteOnly (подстановка номеров,
     * лимит сборки), и для предупреждения «горящие контракты + дефицит запчастей» в режиме «по объёму контракта».
     */
    const inRepairByContractAndBrand = new Map<string, Map<string, string[]>>();
    for (const engineId of getIdsByType(snapshot, 'engine')) {
      const eattrs = snapshot.attrsByEntity.get(engineId) ?? {};
      const cid = normalizeText(eattrs.contract_id, '');
      if (!scoredContractIds.has(cid)) continue;
      if (!eattrs.status_repair_started) continue;
      if (eattrs.status_customer_accepted) continue;
      if (eattrs.status_rejected) continue;
      const bid = normalizeText(eattrs.engine_brand_id, normalizeText(eattrs.engine_brand, ''));
      if (!passesBrandAndBom(bid)) continue;
      const engineNumber = normalizeText(eattrs.engine_number, '');
      const contractScore = scoredByContractId.get(cid)?.score ?? 0;
      const contractLabel = scoredByContractId.get(cid)?.label ?? '';
      const arr = onSiteEnginesByBrand.get(bid) ?? [];
      arr.push({
        engineId,
        engineNumber,
        contractId: cid,
        contractLabel,
        contractScore,
      });
      onSiteEnginesByBrand.set(bid, arr);

      const byBrand = inRepairByContractAndBrand.get(cid) ?? new Map<string, string[]>();
      const list = byBrand.get(bid) ?? [];
      list.push(engineNumber || `(№${engineId.slice(0, 8)})`);
      byBrand.set(bid, list);
      inRepairByContractAndBrand.set(cid, byBrand);
    }
    /** В очереди номеров приоритет: самые отстающие контракты первыми, затем по возрастанию номера. */
    for (const list of onSiteEnginesByBrand.values()) {
      list.sort((a, b) => {
        if (b.contractScore !== a.contractScore) return b.contractScore - a.contractScore;
        return a.engineNumber.localeCompare(b.engineNumber, 'ru');
      });
    }
    for (const row of scored) {
      const byBrand = inRepairByContractAndBrand.get(row.contractId) ?? new Map<string, string[]>();
      const inRepairEngineNumbers = Array.from(byBrand.values()).flat().sort((a, b) => a.localeCompare(b, 'ru'));
      hotContractsForWarning.push({
        contractId: row.contractId,
        label: row.label,
        customerLabel: row.customerLabel,
        daysLeft: row.daysLeft,
        actualPct: row.actualPct,
        brandIds: row.brandIds,
        inRepairEngineNumbers,
      });
    }

    if (onSiteOnly) {
      const repairStartedByBrand = new Map<string, number>();
      for (const [bid, list] of onSiteEnginesByBrand) {
        repairStartedByBrand.set(bid, list.length);
      }

      const firstRank = new Map<string, number>();
      let pr = 0;
      for (const bid of priorityEngineBrandIds) {
        if (!firstRank.has(bid)) firstRank.set(bid, pr);
        pr++;
      }

      const reordered = priorityEngineBrandIds.filter((bid) => (repairStartedByBrand.get(bid) ?? 0) > 0);
      reordered.sort((a, b) => {
        const ca = repairStartedByBrand.get(a) ?? 0;
        const cb = repairStartedByBrand.get(b) ?? 0;
        if (cb !== ca) return cb - ca;
        return (firstRank.get(a) ?? 0) - (firstRank.get(b) ?? 0);
      });

      const extra: string[] = [];
      for (const [bid, n] of repairStartedByBrand) {
        if (n > 0 && !reordered.includes(bid)) extra.push(bid);
      }
      extra.sort((a, b) => (repairStartedByBrand.get(b) ?? 0) - (repairStartedByBrand.get(a) ?? 0));

      priorityEngineBrandIds = [...reordered, ...extra];

      for (const [bid, n] of repairStartedByBrand) {
        if (n > 0) brandMaxMap.set(bid, n);
      }

      if (repairStartedByBrand.size === 0) {
        volumeModeHints.push(
          'Режим «только на заводе»: по отстающим контрактам нет прикреплённых двигателей со статусом «Начат ремонт» (не считаются принятые заказчиком и забракованные).',
        );
      } else {
        volumeModeHints.push(
          'Учёт только на заводе: лимит сборки по марке — число таких двигателей; порядок приоритета марок — по убыванию этого числа.',
        );
      }
    } else {
      for (const row of scored) {
        const attrs = snapshot.attrsByEntity.get(row.contractId) ?? {};
        const sections = parseContractSections(attrs);
        const planned = sumEngineBrandQtyByBrandFromContractSections(sections);
        const completedByBrand = new Map<string, number>();
        for (const engineId of getIdsByType(snapshot, 'engine')) {
          const eattrs = snapshot.attrsByEntity.get(engineId) ?? {};
          if (normalizeText(eattrs.contract_id, '') !== row.contractId) continue;
          const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
          for (const code of STATUS_CODES) statusFlags[code] = Boolean(eattrs[code]);
          const prog = computeObjectProgress(statusFlags);
          if (!eattrs.status_customer_accepted && prog < 99.5) continue;
          const bid = normalizeText(eattrs.engine_brand_id, normalizeText(eattrs.engine_brand, ''));
          if (!bid) continue;
          completedByBrand.set(bid, (completedByBrand.get(bid) ?? 0) + 1);
        }
        for (const [brandId, pq] of planned) {
          const done = completedByBrand.get(brandId) ?? 0;
          const rem = Math.max(0, Math.floor(pq - done));
          if (rem <= 0) continue;
          if (!passesBrandAndBom(brandId)) continue;
          brandMaxMap.set(brandId, (brandMaxMap.get(brandId) ?? 0) + rem);
        }
      }
      if (brandMaxMap.size > 0) {
        volumeModeHints.push(
          'Полный объём контракта: лимит сборки по марке — остаток к исполнению (сумма qty по маркам в первичном договоре и ДС минус уже завершённые прикреплённые двигатели).',
        );
      }
    }
  }

  const footerNotes: string[] = [...mismatchNotes];
  const modeHints: string[] = [...volumeModeHints];
  if (selectedContractIds.size > 0) {
    modeHints.push(`Ограничение: авто-приоритет только среди ${selectedContractIds.size} выбранных контракт(ов).`);
  }
  if (missingBomBrandLabels.size > 0) {
    const list = Array.from(missingBomBrandLabels.entries())
      .map(([, lab]) => lab)
      .sort((a, b) => a.localeCompare(b, 'ru'));
    footerNotes.push(
      `Марки без активной default BOM в справочнике (прогноз сборки в отчёте для них невозможен; по контрактам их всё равно нужно обеспечивать): ${list.join('; ')}.`,
    );
  }
  if (scored.length === 0) {
    modeHints.push(
      'Авто: нет контрактов для приоритета (исполненные и просроченные не учитываются; нужны непросроченные контракты с отставанием от графика и марки в BOM).',
    );
  } else {
    modeHints.push(`Авто-приоритет по отставанию: ${priorityEngineBrandIds.length} марок, ${scored.length} контр.`);
    footerNotes.push('Контракты с отставанием (не исполнены, срок в будущем; самые отстающие — выше):');
    for (const row of scored.slice(0, 12)) {
      const duePart = row.daysLeft == null ? 'срок не задан' : `до срока ${row.daysLeft} дн.`;
      const dueDatePart = row.dueAt == null ? 'дата исполнения: —' : `дата исполнения: ${formatMoscowDate(row.dueAt)}`;
      const expPart = row.expected == null ? '—' : `${row.expected.toFixed(0)}%`;
      footerNotes.push(
        `• ${row.label}: заказчик «${row.customerLabel}», ${dueDatePart}, ${duePart}; исполнение ${row.actualPct.toFixed(0)}%, по графику ~${expPart}, двигателей не завершено: ${row.pendingEngines}.`,
      );
    }
  }

  return {
    priorityEngineBrandIds,
    footerNotes,
    modeHints,
    onSiteEnginesByBrand,
    hotContractsForWarning,
    ...(brandMaxMap.size > 0 ? { brandMaxEnginesHorizon: Object.fromEntries(brandMaxMap) } : {}),
  };
}

/** Убирает из текста отчёта для оператора внутренние маркеры вариантов BOM и UUID. */
export const ASSEMBLY_FORECAST_UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
export const ASSEMBLY_FORECAST_KIT_MARKER = /\s*\[__kit_[^\]]+]/gi;

export function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s).trim());
}

export function sanitizeAssemblyForecastOperatorText(raw: string): string {
  let s = String(raw ?? '');
  s = s.replace(ASSEMBLY_FORECAST_KIT_MARKER, '');
  s = s.replace(ASSEMBLY_FORECAST_UUID_TOKEN, '');
  s = s.replace(/\(\s*\)/g, '');
  s = s.replace(/;\s*;/g, ';');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

export function formatAssemblyDeficitHintsForPriorityBrands(deficitRecommendations: unknown[], priorityLabelSet: Set<string>): string[] {
  if (priorityLabelSet.size === 0) return [];
  const lines: Array<{ deficit: number; text: string }> = [];
  for (const raw of deficitRecommendations) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Record<string, unknown>;
    const brands = Array.isArray(d.usedByBrands) ? (d.usedByBrands as unknown[]).map((b) => String(b).trim()).filter(Boolean) : [];
    if (!brands.some((b) => priorityLabelSet.has(b))) continue;
    const partLabel = normalizeText(d.partLabel, '');
    const deficit = Math.max(0, Math.floor(toNumber(d.deficit)));
    if (!partLabel || deficit <= 0) continue;
    const brPart = brands.filter((b) => priorityLabelSet.has(b)).slice(0, 4).join(', ');
    const stock = Math.max(0, Math.floor(toNumber(d.currentStock)));
    const incoming = Math.max(0, Math.floor(toNumber(d.totalPlannedIncoming)));
    const req = Math.max(0, Math.floor(toNumber(d.totalRequired)));
    let situation: string;
    if (stock <= 0) {
      situation = 'уже дефицит на складе';
    } else if (incoming > 0 && deficit > 0) {
      situation = 'к концу горизонта не хватит; часть закроет планируемый приход';
    } else {
      situation = 'к концу горизонта ожидается дефицит при текущих остатках';
    }
    // Ремфонд-осведомлённость (Ф1 плана forecast-remfond-aware-2026-07): раскладываем дефицит
    // на «закрыть ремонтом» (фонд есть) и «закупить» (фонда нет) — подсказка снабжению.
    const repairFundQty = Math.max(0, Math.floor(toNumber(d.repairFundQty)));
    const coverable = Math.min(deficit, Math.max(0, Math.floor(toNumber(d.coverableByRepairFund))));
    const toPurchase = Math.max(0, deficit - coverable);
    let action: string;
    if (coverable >= deficit) {
      action = `в ремфонде ${repairFundQty} шт. — весь дефицит закрывается ремонтом: выдать ремнаряд на ~${coverable} шт.`;
    } else if (coverable > 0) {
      action = `в ремфонде ${repairFundQty} шт. — ремонтом закрыть ~${coverable} шт. (выдать ремнаряд), закупить ~${toPurchase} шт.`;
    } else {
      action = `ремфонд пуст — закупка ~${toPurchase} шт. (заявка в снабжение)`;
    }
    lines.push({
      deficit,
      text: sanitizeAssemblyForecastOperatorText(
        `${partLabel} — ${situation}: не хватает ~${deficit} шт. (нужно ~${req}, на складе ${stock}, приход по плану ~${incoming}; марки: ${brPart || '—'}). ${action}`,
      ),
    });
  }
  lines.sort((a, b) => b.deficit - a.deficit);
  return lines.slice(0, 12).map((l) => l.text);
}

export async function buildAssemblyForecast7dReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const snapshot = await loadSnapshot(db);
  const bomBrandIds = await loadActiveDefaultBomEngineBrandIds(db);
  /** Прогноз всегда считается на сервере; локальные таблицы BOM в SQLite могут быть пустыми (ledger pull их не заполняет). */
  const assemblyForecastApiEnabled = Boolean(ctx?.sysDb && String(ctx?.apiBaseUrl ?? '').trim());
  const mode = normalizeText(filters?.assemblyPriorityMode, 'manual');
  const onSiteOnly = mode === 'contracts' && Boolean(filters?.assemblyForecastOnSiteOnly);
  let priorityEngineBrandIds = asArray(filters?.priorityEngineBrandIds);
  let contractFooterNotes: string[] = [];
  let modeHints: string[] = [];
  let brandMaxEnginesHorizon: Record<string, number> | undefined;
  let onSiteEnginesByBrand: ContractBasedAssemblyPriorityResult['onSiteEnginesByBrand'] = new Map();
  let hotContractsForWarning: ContractBasedAssemblyPriorityResult['hotContractsForWarning'] = [];
  const manualBomFooter: string[] = [];
  if (mode === 'contracts') {
    const contractBomIds =
      assemblyForecastApiEnabled && bomBrandIds.size === 0 ? null : bomBrandIds;
    const p = computeContractBasedAssemblyPriorityFromSnapshot(snapshot, filters, contractBomIds);
    priorityEngineBrandIds = p.priorityEngineBrandIds;
    contractFooterNotes = p.footerNotes;
    modeHints = p.modeHints;
    brandMaxEnginesHorizon = p.brandMaxEnginesHorizon;
    onSiteEnginesByBrand = p.onSiteEnginesByBrand;
    hotContractsForWarning = p.hotContractsForWarning;
  } else {
    const manualIds = asArray(filters?.priorityEngineBrandIds)
      .map((id) => String(id).trim())
      .filter(Boolean);
    const missingManual = manualIds.filter((id) => !bomBrandIds.has(id));
    if (missingManual.length > 0 && !assemblyForecastApiEnabled) {
      const list = missingManual
        .map((id) => {
          const lab = entityLabel(snapshot.attrsByEntity.get(id), id).trim();
          if (lab && !isUuidLike(lab)) return lab;
          return 'марка без названия в справочнике';
        })
        .sort((a, b) => a.localeCompare(b, 'ru'));
      manualBomFooter.push(
        `Приоритетные марки без активной default BOM (прогноз сборки в отчёте для них невозможен; обеспечение заказывайте отдельно): ${list.join('; ')}.`,
      );
    }
  }

  const priorityLabelSet = new Set<string>();
  for (const id of priorityEngineBrandIds) {
    const lb = entityLabel(snapshot.attrsByEntity.get(id), id).trim() || id;
    priorityLabelSet.add(lb);
  }

  async function viaApi(): Promise<{ report: OkPreview } | { skip: true } | { error: string }> {
    const apiBaseUrl = String(ctx?.apiBaseUrl ?? '').trim();
    if (!ctx?.sysDb || !apiBaseUrl) return { skip: true };
    const targetEnginesPerDay = Math.max(0, Math.floor(Number(filters?.targetEnginesPerDay ?? 4)));
    const sameBrandBatchSize = Math.max(1, Math.floor(Number(filters?.sameBrandBatchSize ?? 2)));
    const horizonDays = Math.max(1, Math.min(31, Math.floor(Number(filters?.horizonDays ?? 7))));
    const warehouseIds = asArray(filters?.warehouseIds);
    const engineBrandIds = asArray(filters?.engineBrandIds);
    const workingWeekdays = asArray(filters?.workingWeekdays)
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
    const payload = {
      targetEnginesPerDay,
      sameBrandBatchSize,
      horizonDays,
      ...(warehouseIds.length > 0 ? { warehouseIds } : {}),
      ...(engineBrandIds.length > 0 ? { engineBrandIds } : {}),
      ...(priorityEngineBrandIds.length > 0 ? { priorityEngineBrandIds } : {}),
      ...(workingWeekdays.length > 0 ? { workingWeekdays } : {}),
      ...(brandMaxEnginesHorizon && Object.keys(brandMaxEnginesHorizon).length > 0 ? { brandMaxEnginesHorizon } : {}),
    };
    try {
      const r = await httpAuthed(
        ctx.sysDb,
        apiBaseUrl,
        '/warehouse/forecast/assembly-7d',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        { timeoutMs: 45_000 },
      );
      if (!r.ok) return { error: `Не удалось получить прогноз от backend: ${formatHttpError(r)}` };
      if (!r.json || typeof r.json !== 'object' || (r.json as Record<string, unknown>).ok !== true) {
        return { error: 'API прогноза вернул некорректный ответ' };
      }
      const body = r.json as Record<string, unknown>;
      const rowsRaw = Array.isArray(body.rows) ? body.rows : [];
      type OnSiteEngineEntry = { engineId: string; engineNumber: string; contractId: string; contractLabel: string; contractScore: number };
      /** Очереди номеров двигателей по базовой марке: расход по rows в порядке появления `ok`-строк. */
      const onSiteEngineQueueByBrand = new Map<string, OnSiteEngineEntry[]>();
      if (onSiteOnly) {
        for (const [bid, list] of onSiteEnginesByBrand) {
          onSiteEngineQueueByBrand.set(bid, [...list]);
        }
      }
      /** Базовый id марки из API (`uuid::variant` -> `uuid`). */
      function baseBrandIdFromApiRow(raw: unknown): string {
        const id = String(raw ?? '').trim();
        const sep = id.indexOf('::');
        return sep >= 0 ? id.slice(0, sep) : id;
      }
      // Stage 4: Map активных Assembly-нарядов из backend ответа — нужна для блокировки кнопки
      // «Создать наряд на сборку» в UI по совпадению variantKey строки.
      const existingAssemblyOrdersByVariantKey =
        body.existingAssemblyOrdersByVariantKey && typeof body.existingAssemblyOrdersByVariantKey === 'object'
          ? (body.existingAssemblyOrdersByVariantKey as Record<string, { operationId: string; workOrderNumber: number }>)
          : {};
      const rows = rowsRaw.map((row) => {
        const r0 = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        const rawStatus = normalizeText(r0.status, '');
        const statusCode = normalizeAssemblyForecastStatusFromApi(rawStatus);
        const baseBrandId = baseBrandIdFromApiRow(r0.brandId);
        let engineBrandLabel = sanitizeAssemblyForecastOperatorText(normalizeText(r0.engineBrand, ''));
        let engineNumberForRow = '';
        let engineIdForRow = '';
        if (onSiteOnly && statusCode === 'ok' && baseBrandId) {
          const queue = onSiteEngineQueueByBrand.get(baseBrandId);
          if (queue && queue.length > 0) {
            const assigned = queue.shift();
            if (assigned) {
              engineNumberForRow = assigned.engineNumber;
              engineIdForRow = assigned.engineId;
              const numLabel = engineNumberForRow ? `№${engineNumberForRow}` : `двигатель`;
              const contractLabel = assigned.contractLabel ? ` · контракт «${assigned.contractLabel}»` : '';
              engineBrandLabel = sanitizeAssemblyForecastOperatorText(`${engineBrandLabel} · ${numLabel}${contractLabel}`);
            }
          }
        }
        // Stage 4: прокидываем структурированные данные варианта (requiredParts / variantKey)
        // в preview-row для UI. ReportCellValue допускает string, поэтому объекты упаковываем
        // в JSON (UI распакует при рендере кнопки «Создать наряд на сборку»).
        const variantKeyRaw = typeof r0.variantKey === 'string' ? r0.variantKey : '';
        const existingOrder = variantKeyRaw ? existingAssemblyOrdersByVariantKey[variantKeyRaw] ?? null : null;
        const requiredPartsRaw = Array.isArray(r0.requiredParts) ? r0.requiredParts : [];
        return {
          dayLabel: sanitizeAssemblyForecastOperatorText(normalizeText(r0.dayLabel, '')),
          engineBrand: engineBrandLabel,
          plannedEngines: Math.max(0, toNumber(r0.plannedEngines)),
          status: assemblyForecastStatusLabelRu(statusCode),
          requiredComponentsSummary: sanitizeAssemblyForecastOperatorText(normalizeText(r0.requiredComponentsSummary, '')),
          _assemblyStatusCode: statusCode,
          _assemblyBrandId: baseBrandId,
          _assemblyVariantKey: variantKeyRaw,
          _assemblyRequiredPartsJson: JSON.stringify(requiredPartsRaw),
          _assemblyExistingOrderJson: existingOrder ? JSON.stringify(existingOrder) : '',
          // Stage 4 followup (v1.29.2): когда `assemblyForecastOnSiteOnly` включён, прогноз
          // выделил конкретный двигатель «в ремонте» для этой строки. Прокидываем engineId
          // и engineNumber в UI → handler `createAssemblyFromForecast` подставит их в наряд.
          _assemblyOnSiteEngineId: engineIdForRow,
          _assemblyOnSiteEngineNumber: engineNumberForRow,
        } as Record<string, ReportCellValue>;
      });
      /** Двигатели «в ремонте», для которых в плане прогноза не нашлось ok-строки — сигналим отдельно. */
      const unassignedOnSiteEngines: Array<{ brandId: string; engineNumber: string; contractLabel: string }> = [];
      if (onSiteOnly) {
        for (const [bid, leftQueue] of onSiteEngineQueueByBrand) {
          for (const eng of leftQueue) {
            unassignedOnSiteEngines.push({ brandId: bid, engineNumber: eng.engineNumber, contractLabel: eng.contractLabel });
          }
        }
      }
      const warnings = Array.isArray(body.warnings)
        ? body.warnings.map((w) => sanitizeAssemblyForecastOperatorText(String(w))).filter(Boolean)
        : [];
      // Открытые Assembly-наряды из ПРЕЖНИХ прогнозов: variantKey содержит относительный
      // dayOffset, поэтому на следующий день ключ уже не матчит строки текущего прогноза —
      // кнопка «Создать наряд» для того же реального дефицита не блокируется. Показываем
      // номера таких нарядов, чтобы оператор проверил их перед выпиской новых (дубль-риск).
      {
        const matchedKeys = new Set(rows.map((r) => String(r._assemblyVariantKey ?? '')).filter(Boolean));
        const staleOrders = Object.entries(existingAssemblyOrdersByVariantKey)
          .filter(([key]) => !matchedKeys.has(key))
          .map(([, v]) => Number(v?.workOrderNumber ?? 0))
          .filter((n) => n > 0)
          .sort((a, b) => a - b);
        if (staleOrders.length > 0) {
          warnings.push(
            `Открытые наряды на сборку из прежних прогнозов: ${staleOrders.map((n) => `№${n}`).join(', ')} — проверьте их перед созданием новых нарядов (текущий прогноз эти варианты уже не блокирует).`,
          );
        }
      }
      const horizonMissingByBrand = Array.isArray(body.horizonMissingByBrand)
        ? body.horizonMissingByBrand
            .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
            .map((x) => ({
              brandLabel: sanitizeAssemblyForecastOperatorText(normalizeText(x.brandLabel, '')),
              missingEngines: Math.max(0, Math.floor(toNumber(x.missingEngines))),
            }))
            .filter((x) => x.brandLabel && x.missingEngines > 0)
        : [];
      const horizonComponentNeeds = Array.isArray(body.horizonComponentNeeds)
        ? body.horizonComponentNeeds
            .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
            .map((x) => ({
              partLabel: sanitizeAssemblyForecastOperatorText(normalizeText(x.partLabel, '')),
              requiredQty: Math.max(0, Math.floor(toNumber(x.requiredQty))),
              forBrands: Array.isArray(x.forBrands)
                ? x.forBrands.map((b) => sanitizeAssemblyForecastOperatorText(normalizeText(b, ''))).filter(Boolean)
                : [],
            }))
            .filter((x) => x.partLabel && x.requiredQty > 0)
        : [];
      const deficitHints =
        mode === 'contracts' || priorityEngineBrandIds.length > 0
          ? formatAssemblyDeficitHintsForPriorityBrands(
              Array.isArray(body.deficitRecommendations) ? body.deficitRecommendations : [],
              priorityLabelSet,
            )
          : [];
      const deficitFooter =
        deficitHints.length > 0
          ? [
              'Комплектующие: дефицит или риск дефицита для приоритетных марок (оценка на горизонт × целевой выпуск в сутки; учтены остатки и планируемые приходы):',
              ...deficitHints,
            ]
          : [];
      const horizonGapFooter =
        horizonMissingByBrand.length > 0
          ? [
              sanitizeAssemblyForecastOperatorText(`Недовыпуск на горизонт ${horizonDays} дн. (цель ${targetEnginesPerDay}/сутки):`),
              ...horizonMissingByBrand
                .slice(0, 20)
                .map((b) =>
                  sanitizeAssemblyForecastOperatorText(`${b.brandLabel}: не хватает собрать ещё ~${b.missingEngines} двиг.`),
                ),
              ...(horizonComponentNeeds.length > 0
                ? [
                    'Чтобы закрыть горизонт, дополнительно нужны комплектующие (оценка):',
                    ...horizonComponentNeeds
                      .slice(0, 30)
                      .map((p) =>
                        sanitizeAssemblyForecastOperatorText(
                          `${p.partLabel}: ~${p.requiredQty} шт.${p.forBrands.length ? ` (марки: ${p.forBrands.slice(0, 4).join(', ')})` : ''}`,
                        ),
                      ),
                  ]
                : []),
            ]
          : [];

      /** Спец-уведомление: «горящие» контракты с двигателями в ремонте и нехваткой запчастей. */
      const hotShortageFooter: string[] = [];
      if (mode === 'contracts' && hotContractsForWarning.length > 0 && horizonMissingByBrand.length > 0) {
        const missingBrandLabelSet = new Set(horizonMissingByBrand.map((b) => b.brandLabel));
        const brandLabelById = (id: string) => entityLabel(snapshot.attrsByEntity.get(id), id).trim() || id;
        const flagged: string[] = [];
        for (const hc of hotContractsForWarning) {
          if (hc.inRepairEngineNumbers.length === 0) continue;
          const hotBrandLabels = hc.brandIds
            .map((id) => brandLabelById(id))
            .filter((lab) => missingBrandLabelSet.has(sanitizeAssemblyForecastOperatorText(lab)));
          if (hotBrandLabels.length === 0) continue;
          const dueChunk =
            hc.daysLeft == null ? 'срок не задан' : hc.daysLeft <= 0 ? 'срок исчерпан' : `до срока ${hc.daysLeft} дн.`;
          flagged.push(
            sanitizeAssemblyForecastOperatorText(
              `• Контракт «${hc.label}» (заказчик «${hc.customerLabel}», ${dueChunk}, исполнение ${hc.actualPct.toFixed(0)}%): двигатели в ремонте — ${hc.inRepairEngineNumbers.map((n) => `№${n}`).join(', ')}. Дефицит по маркам: ${hotBrandLabels.join(', ')}.`,
            ),
          );
        }
        if (flagged.length > 0) {
          hotShortageFooter.push(
            '⚠️ Горящие контракты с отставанием от графика: есть двигатели в ремонте, но запчастей для срочной сборки не хватает.',
          );
          hotShortageFooter.push(...flagged.slice(0, 16));
        }
      }
      const unassignedOnSiteFooter: string[] = [];
      if (onSiteOnly && unassignedOnSiteEngines.length > 0) {
        const byBrand = new Map<string, Array<{ engineNumber: string; contractLabel: string }>>();
        for (const e of unassignedOnSiteEngines) {
          const arr = byBrand.get(e.brandId) ?? [];
          arr.push({ engineNumber: e.engineNumber, contractLabel: e.contractLabel });
          byBrand.set(e.brandId, arr);
        }
        const brandLabelById = (id: string) => entityLabel(snapshot.attrsByEntity.get(id), id).trim() || id;
        unassignedOnSiteFooter.push(
          'Двигатели в ремонте, не попавшие в горизонт плана (нет запчастей или закрыт лимит/выходные):',
        );
        for (const [bid, list] of byBrand) {
          const lab = brandLabelById(bid);
          unassignedOnSiteFooter.push(
            sanitizeAssemblyForecastOperatorText(
              `• ${lab}: ${list.map((e) => `№${e.engineNumber || '—'}${e.contractLabel ? ` (${e.contractLabel})` : ''}`).join(', ')}`,
            ),
          );
        }
      }

      const footerNotes = [
        ...hotShortageFooter,
        ...contractFooterNotes,
        ...manualBomFooter,
        ...deficitFooter,
        ...horizonGapFooter,
        ...unassignedOnSiteFooter,
      ]
        .filter(Boolean)
        .map(sanitizeAssemblyForecastOperatorText);
      const preset = getPreset('assembly_forecast_7d');
      const prioritySubtitle =
        mode === 'contracts'
          ? `Приоритет: авто по контрактам${priorityEngineBrandIds.length ? ` (${priorityEngineBrandIds.length} марок)` : ''}`
          : priorityEngineBrandIds.length
            ? `Приоритет марок (вручную): ${priorityEngineBrandIds.length}`
            : 'Приоритет марок: нет';
      const subtitleParts = [
        sanitizeAssemblyForecastOperatorText(`Цель: ${targetEnginesPerDay}/сутки`),
        sanitizeAssemblyForecastOperatorText(`Серия одной марки: ${sameBrandBatchSize}`),
        sanitizeAssemblyForecastOperatorText(`Горизонт: ${horizonDays} дн.`),
        sanitizeAssemblyForecastOperatorText(
          warehouseIds.length ? `Склады: ${warehouseIds.length}` : 'Склады: все (сумма)',
        ),
        sanitizeAssemblyForecastOperatorText(prioritySubtitle),
        ...modeHints.map(sanitizeAssemblyForecastOperatorText),
        ...warnings,
      ];
      // Ф2 плана forecast-remfond-aware-2026-07: структурированные дефициты (все марки, не только
      // приоритетные) — UI строит из них «Создать заявку в снабжение» по позициям toPurchase > 0.
      const assemblyDeficits = (Array.isArray(body.deficitRecommendations) ? body.deficitRecommendations : [])
        .map((raw) => {
          const d = (raw ?? {}) as Record<string, unknown>;
          const deficit = Math.max(0, Math.floor(toNumber(d.deficit)));
          const repairFundQty = Math.max(0, Math.floor(toNumber(d.repairFundQty)));
          const coverableByRepairFund = Math.min(deficit, Math.max(0, Math.floor(toNumber(d.coverableByRepairFund))));
          return {
            nomenclatureId: normalizeText(d.nomenclatureId, ''),
            partLabel: sanitizeAssemblyForecastOperatorText(normalizeText(d.partLabel, '')),
            deficit,
            repairFundQty,
            coverableByRepairFund,
            toPurchase: Math.max(0, deficit - coverableByRepairFund),
          };
        })
        .filter((d) => d.nomenclatureId && d.partLabel && d.deficit > 0);
      return {
        report: {
          ok: true,
          presetId: 'assembly_forecast_7d',
          title: preset.title,
          subtitle: subtitleParts.join(' | '),
          columns: preset.columns,
          rows,
          totals: {
            forecastRows: rows.length,
            plannedEngines: rows.reduce((acc, row) => acc + toNumber(row.plannedEngines), 0),
          },
          ...(footerNotes.length > 0 ? { footerNotes } : {}),
          ...(assemblyDeficits.length > 0 ? { assemblyDeficits } : {}),
          generatedAt: Date.now(),
        },
      };
    } catch (e) {
      return { error: `Ошибка вызова API прогноза: ${String(e)}` };
    }
  }

  const remote = await viaApi();
  if ('report' in remote) return remote.report;
  if ('error' in remote) return { ok: false, error: remote.error };
  return { ok: false, error: 'Локальный fallback отключен: отчет использует BOM-прогноз только через backend API.' };
}

