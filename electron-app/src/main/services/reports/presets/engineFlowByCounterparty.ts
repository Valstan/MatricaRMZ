import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_FLOW_BY_COUNTERPARTY_COLUMNS,
  ENGINE_FLOW_DEFAULT_PRINT_LAYOUT,
  ENGINE_FLOW_PRINT_SECTIONS,
  ENGINE_FLOW_REQUIRED_COLUMN_KEYS,
  ENGINE_INTERNAL_NUMBER_CODE,
  STATUS_CODES,
  isContractAddonToken,
  isScrapEngine,
  parseContractSections,
  resolveReportPrintLayout,
  shortContractSuffixLabel,
  visibleReportColumns,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  type StatusCode,
  } from '@matricarmz/shared';

import { resolveEngineShippingState } from '../../reportEngineShippingState.js';

import { normalizeText, asArray, asNumberOrNull, entityLabel, toNumber } from '../format.js';
import { getPreset, loadSnapshot, getIdsByType } from '../context.js';
import { BRAND_MISSING, buildOptions, buildCounterpartyOptions, resolveCounterpartyLabel } from '../options.js';

const NO_COUNTERPARTY = '(без заказчика)';
const NO_CONTRACT = '(без договора)';
const NO_BRAND = '(без марки)';
const NO_YEAR = 'Без даты прихода';
/** Ключ сортировки блока «без даты прихода»: всегда в конце, при любом порядке годов. */
const NO_YEAR_KEY = '0000';

type FlowAgg = {
  arrived: number;
  shipped: number;
  scrapTotal: number;
  scrapAtFactory: number;
  scrapSent: number;
  atFactory: number;
  inRepair: number;
};

type BrandNode = { label: string; agg: FlowAgg };
type ContractNode = {
  shortLabel: string;
  fullLabel: string;
  sectionToken: string;
  sortKey: string;
  total: FlowAgg;
  brands: Map<string, BrandNode>;
};
type CounterpartyNode = { label: string; total: FlowAgg; contracts: Map<string, ContractNode> };
type YearNode = { label: string; total: FlowAgg; counterparties: Map<string, CounterpartyNode> };

function emptyFlowAgg(): FlowAgg {
  return { arrived: 0, shipped: 0, scrapTotal: 0, scrapAtFactory: 0, scrapSent: 0, atFactory: 0, inRepair: 0 };
}

function accFlow(target: FlowAgg, delta: FlowAgg): void {
  target.arrived += delta.arrived;
  target.shipped += delta.shipped;
  target.scrapTotal += delta.scrapTotal;
  target.scrapAtFactory += delta.scrapAtFactory;
  target.scrapSent += delta.scrapSent;
  target.atFactory += delta.atFactory;
  target.inRepair += delta.inRepair;
}

/**
 * Отчёт «Движение двигателей по заказчикам» — печатная форма А4 с иерархией
 * год прихода → заказчик → договор (короткая метка + ДС) → марка двигателя.
 *
 * Год берётся из `arrival_date` двигателя (при пустом — `acceptance_at`): бумага по годам
 * — это разрез «что завод принял в таком-то году», поэтому дата прихода, а не отгрузки.
 * Двигатели без обеих дат собираются в блок «Без даты прихода» в конце.
 *
 * Состояния двигателя не пересчитываются: переиспользуются каноническая
 * `resolveEngineShippingState` (отгрузка заказчику по customer_sent/accepted) и
 * `isScrapEngine`. Три состояния взаимоисключающие, чтобы бумага сходилась:
 * - `scrapSent` — `status_rework_sent`: утиль вернули заказчику, завод покинул;
 * - `shipped` — покинул завод как отремонтированный (не rework);
 * - `atFactory` — всё остальное; внутри делится на `scrapAtFactory` (утиль признан,
 *   но ещё лежит у нас) и `inRepair`.
 *
 * Отсюда инвариант каждого уровня: `arrived = shipped + scrapSent + atFactory`
 * и `atFactory = scrapAtFactory + inRepair`.
 *
 * Заказчик берётся у двигателя, а при пустом поле — у его договора: иначе половина
 * парка утекала бы в группу «(без заказчика)», ведь в карточке двигателя заказчик
 * обычно не дублируется.
 */
export async function buildEngineFlowByCounterpartyReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const brandFilter = asArray(filters?.brandIds);
  const contractFilter = asArray(filters?.contractIds);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const arrivalStart = asNumberOrNull(filters?.arrivalStartMs);
  const arrivalEnd = asNumberOrNull(filters?.arrivalEndMs);
  const shippingStart = asNumberOrNull(filters?.shippingStartMs);
  const shippingEnd = asNumberOrNull(filters?.shippingEndMs);
  const scrapFilter = normalizeText(filters?.scrapFilter, 'all');
  const onSiteFilter = normalizeText(filters?.onSiteFilter, 'all');
  const repairActiveFilter = normalizeText(filters?.repairActiveFilter, 'all');
  const contractSectionFilter = normalizeText(filters?.contractSectionFilter, 'all');
  const engineNumberQuery = normalizeText(filters?.engineNumberQuery, '').trim().toLowerCase();
  const yearOrderAsc = normalizeText(filters?.yearOrder, 'desc') === 'asc';
  const layout = resolveReportPrintLayout(filters?.printLayout, ENGINE_FLOW_DEFAULT_PRINT_LAYOUT, {
    columns: ENGINE_FLOW_BY_COUNTERPARTY_COLUMNS,
    requiredKeys: ENGINE_FLOW_REQUIRED_COLUMN_KEYS,
  });
  // Своды и подытоги оператор гасит чекбоксами фильтров, а рисует их печатная форма —
  // поэтому кладём их в раскладку печати, единственный канал между фильтрами и рендером.
  layout.sections = {
    ...(layout.sections ?? {}),
    [ENGINE_FLOW_PRINT_SECTIONS.brandSummary]: filters?.showBrandSummary !== false,
    [ENGINE_FLOW_PRINT_SECTIONS.contractSubtotals]: filters?.showContractSubtotals !== false,
  };

  const snapshot = await loadSnapshot(db);
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));

  const contractCounterpartyById = new Map<string, string>();
  const contractNumberById = new Map<string, string>();
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const sections = parseContractSections(attrs);
    contractCounterpartyById.set(contractId, normalizeText(sections.primary.customerId ?? attrs.customer_id, ''));
    contractNumberById.set(
      contractId,
      normalizeText(sections.primary.number ?? attrs.contract_number ?? attrs.number, '') || entityLabel(attrs, ''),
    );
  }

  const byYear = new Map<string, YearNode>();
  const grand = emptyFlowAgg();

  for (const engineId of getIdsByType(snapshot, 'engine')) {
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const brandId = normalizeText(attrs.engine_brand_id, '');
    const contractId = normalizeText(attrs.contract_id, '');
    const counterpartyId =
      normalizeText(attrs.counterparty_id ?? attrs.customer_id, '') || (contractId ? contractCounterpartyById.get(contractId) ?? '' : '');

    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;

    const statusFlags: Partial<Record<StatusCode, boolean>> = {};
    for (const code of STATUS_CODES) statusFlags[code] = Boolean(attrs[code]);
    const scrap = isScrapEngine(statusFlags);
    const scrapSent = statusFlags.status_rework_sent === true;
    const { onSite: baseOnSite, shippingDate } = resolveEngineShippingState(attrs);
    const atFactory = baseOnSite && !scrapSent;
    const shipped = !baseOnSite && !scrapSent;
    const scrapAtFactory = scrap && atFactory;

    const arrivalMs = toNumber(attrs.arrival_date) || toNumber(attrs.acceptance_at);
    if (arrivalStart != null && (arrivalMs <= 0 || arrivalMs < arrivalStart)) continue;
    if (arrivalEnd != null && (arrivalMs <= 0 || arrivalMs > arrivalEnd)) continue;
    if (shippingStart != null && (shippingDate == null || shippingDate < shippingStart)) continue;
    if (shippingEnd != null && (shippingDate == null || shippingDate > shippingEnd)) continue;

    if (scrapFilter === 'yes' && !scrap) continue;
    if (scrapFilter === 'no' && scrap) continue;
    if (onSiteFilter === 'yes' && !atFactory) continue;
    if (onSiteFilter === 'no' && atFactory) continue;

    const repairActive = statusFlags.status_repair_started === true;
    if (repairActiveFilter === 'yes' && !repairActive) continue;
    if (repairActiveFilter === 'no' && repairActive) continue;

    // Двигатели одного договора, привязанные к разным ДС, разводятся по строкам:
    // приёмка и отгрузка у ДС свои, и в бумаге их складывают отдельно.
    const sectionToken = normalizeText(attrs.contract_section_number, '');
    const isAddon = isContractAddonToken(sectionToken);
    if (contractSectionFilter === 'primary' && isAddon) continue;
    if (contractSectionFilter === 'addon' && !isAddon) continue;

    if (engineNumberQuery) {
      const haystack = [attrs.engine_number, attrs.number, attrs[ENGINE_INTERNAL_NUMBER_CODE]]
        .map((value) => normalizeText(value, '').toLowerCase())
        .join(' ');
      if (!haystack.includes(engineNumberQuery)) continue;
    }

    const delta: FlowAgg = {
      arrived: 1,
      shipped: shipped ? 1 : 0,
      scrapTotal: scrap ? 1 : 0,
      scrapAtFactory: scrapAtFactory ? 1 : 0,
      scrapSent: scrapSent ? 1 : 0,
      atFactory: atFactory ? 1 : 0,
      inRepair: atFactory && !scrapAtFactory ? 1 : 0,
    };

    const year = arrivalMs > 0 ? new Date(arrivalMs).getFullYear() : null;
    const yearKey = year != null ? String(year) : NO_YEAR_KEY;
    let yearNode = byYear.get(yearKey);
    if (!yearNode) {
      yearNode = { label: year != null ? `${year} год` : NO_YEAR, total: emptyFlowAgg(), counterparties: new Map() };
      byYear.set(yearKey, yearNode);
    }

    const counterpartyKey = counterpartyId || NO_COUNTERPARTY;
    let counterpartyNode = yearNode.counterparties.get(counterpartyKey);
    if (!counterpartyNode) {
      counterpartyNode = {
        label: counterpartyId ? resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId) : NO_COUNTERPARTY,
        total: emptyFlowAgg(),
        contracts: new Map(),
      };
      yearNode.counterparties.set(counterpartyKey, counterpartyNode);
    }

    const contractKey = contractId ? `${contractId}|${sectionToken}` : NO_CONTRACT;
    let contractNode = counterpartyNode.contracts.get(contractKey);
    if (!contractNode) {
      const fullNumber = contractId ? contractNumberById.get(contractId) ?? '' : '';
      contractNode = {
        shortLabel: contractId ? shortContractSuffixLabel(fullNumber, sectionToken) : NO_CONTRACT,
        fullLabel: fullNumber,
        sectionToken,
        sortKey: `${fullNumber}|${sectionToken}`,
        total: emptyFlowAgg(),
        brands: new Map(),
      };
      counterpartyNode.contracts.set(contractKey, contractNode);
    }

    const brandKey = brandId || NO_BRAND;
    let brandNode = contractNode.brands.get(brandKey);
    if (!brandNode) {
      brandNode = {
        // Последний фолбэк — подпись, а не `brandId`: у двигателя со ссылкой на несуществующую
        // марку колонка «Марка» печатала оператору UUID. Разрез при этом не страдает —
        // группируемся по `brandKey`, который так и остаётся идентификатором.
        label: brandId ? brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, BRAND_MISSING) : NO_BRAND,
        agg: emptyFlowAgg(),
      };
      contractNode.brands.set(brandKey, brandNode);
    }

    accFlow(brandNode.agg, delta);
    accFlow(contractNode.total, delta);
    accFlow(counterpartyNode.total, delta);
    accFlow(yearNode.total, delta);
    accFlow(grand, delta);
  }

  const rows: Array<Record<string, ReportCellValue>> = [];
  // «Без даты прихода» всегда последним блоком: при любом порядке годов это не год, а остаток.
  const years = Array.from(byYear.entries()).sort((a, b) => {
    if (a[0] === NO_YEAR_KEY) return 1;
    if (b[0] === NO_YEAR_KEY) return -1;
    return yearOrderAsc ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0]);
  });
  // Счётчики шапки — по уникальным ключам: один договор, приходивший два года подряд,
  // даёт два блока, но остаётся одним договором.
  const counterpartyKeys = new Set<string>();
  const contractKeys = new Set<string>();
  for (const [yearKey, yearNode] of years) {
    const counterparties = Array.from(yearNode.counterparties.entries()).sort((a, b) => a[1].label.localeCompare(b[1].label, 'ru'));
    for (const [counterpartyKey, counterpartyNode] of counterparties) {
      counterpartyKeys.add(counterpartyKey);
      const contracts = Array.from(counterpartyNode.contracts.entries()).sort((a, b) => a[1].sortKey.localeCompare(b[1].sortKey, 'ru'));
      for (const [contractKey, contractNode] of contracts) {
        contractKeys.add(`${counterpartyKey}|${contractKey}`);
        const brands = Array.from(contractNode.brands.values()).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        for (const brandNode of brands) {
          rows.push({
            yearLabel: yearNode.label,
            counterpartyLabel: counterpartyNode.label,
            contractShortLabel: contractNode.shortLabel,
            contractFullLabel: contractNode.fullLabel,
            engineBrand: brandNode.label,
            arrivedQty: brandNode.agg.arrived,
            shippedQty: brandNode.agg.shipped,
            scrapTotalQty: brandNode.agg.scrapTotal,
            scrapAtFactoryQty: brandNode.agg.scrapAtFactory,
            scrapSentQty: brandNode.agg.scrapSent,
            atFactoryQty: brandNode.agg.atFactory,
            inRepairQty: brandNode.agg.inRepair,
            // Служебные ключи для печатной формы: группировать по подписям нельзя —
            // два заказчика могут называться одинаково. В columns не входят, в CSV/1С не попадут.
            _yearKey: yearKey,
            _counterpartyKey: counterpartyKey,
            _contractKey: contractKey,
          });
        }
      }
    }
  }

  const preset = getPreset('engine_flow_by_counterparty');
  const scrapPct = grand.arrived > 0 ? ((grand.scrapTotal / grand.arrived) * 100).toFixed(1) : '0.0';

  return {
    ok: true,
    presetId: preset.id,
    title: preset.title,
    subtitle: `Состояние на текущий момент · лет: ${years.length}, заказчиков: ${counterpartyKeys.size}, договоров: ${contractKeys.size}`,
    columns: visibleReportColumns(ENGINE_FLOW_BY_COUNTERPARTY_COLUMNS, layout),
    rows,
    printLayout: layout,
    totals: {
      years: years.length,
      counterparties: counterpartyKeys.size,
      contracts: contractKeys.size,
      arrivedQty: grand.arrived,
      shippedQty: grand.shipped,
      scrapQty: grand.scrapTotal,
      atFactoryQty: grand.atFactory,
    },
    footerNotes: [
      `Пришло = отправлено заказчику + утиль отправлен + на заводе (${grand.arrived} = ${grand.shipped} + ${grand.scrapSent} + ${grand.atFactory}).`,
      `На заводе = утиль на заводе + в ремонте (${grand.atFactory} = ${grand.scrapAtFactory} + ${grand.inRepair}).`,
      `Доля утиля: ${scrapPct}% (${grand.scrapTotal} из ${grand.arrived}); из них ещё на заводе ${grand.scrapAtFactory}, возвращено заказчику ${grand.scrapSent}.`,
      '«Пришло» — число заведённых карточек двигателей (повторный заезд считается отдельно).',
    ],
    generatedAt: Date.now(),
  };
}
