import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_FLOW_BY_COUNTERPARTY_COLUMNS,
  STATUS_CODES,
  isScrapEngine,
  parseContractSections,
  shortContractLabel,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  type StatusCode,
  } from '@matricarmz/shared';

import { resolveEngineShippingState } from '../../reportEngineShippingState.js';

import { normalizeText, asArray, entityLabel } from '../format.js';
import { getPreset, loadSnapshot, getIdsByType } from '../context.js';
import { buildOptions, buildCounterpartyOptions, resolveCounterpartyLabel } from '../options.js';

const NO_COUNTERPARTY = '(без заказчика)';
const NO_CONTRACT = '(без договора)';
const NO_BRAND = '(без марки)';

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
  sortKey: string;
  total: FlowAgg;
  brands: Map<string, BrandNode>;
};
type CounterpartyNode = { label: string; total: FlowAgg; contracts: Map<string, ContractNode> };

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
 * заказчик → договор (короткая метка + ДС) → марка двигателя.
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

  const byCounterparty = new Map<string, CounterpartyNode>();
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
    const { onSite: baseOnSite } = resolveEngineShippingState(attrs);
    const atFactory = baseOnSite && !scrapSent;
    const shipped = !baseOnSite && !scrapSent;
    const scrapAtFactory = scrap && atFactory;

    const delta: FlowAgg = {
      arrived: 1,
      shipped: shipped ? 1 : 0,
      scrapTotal: scrap ? 1 : 0,
      scrapAtFactory: scrapAtFactory ? 1 : 0,
      scrapSent: scrapSent ? 1 : 0,
      atFactory: atFactory ? 1 : 0,
      inRepair: atFactory && !scrapAtFactory ? 1 : 0,
    };

    const counterpartyKey = counterpartyId || NO_COUNTERPARTY;
    let counterpartyNode = byCounterparty.get(counterpartyKey);
    if (!counterpartyNode) {
      counterpartyNode = {
        label: counterpartyId ? resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId) : NO_COUNTERPARTY,
        total: emptyFlowAgg(),
        contracts: new Map(),
      };
      byCounterparty.set(counterpartyKey, counterpartyNode);
    }

    // Двигатели одного договора, привязанные к разным ДС, разводятся по строкам:
    // приёмка и отгрузка у ДС свои, и в бумаге их складывают отдельно.
    const sectionToken = normalizeText(attrs.contract_section_number, '');
    const contractKey = contractId ? `${contractId}|${sectionToken}` : NO_CONTRACT;
    let contractNode = counterpartyNode.contracts.get(contractKey);
    if (!contractNode) {
      const fullNumber = contractId ? contractNumberById.get(contractId) ?? '' : '';
      contractNode = {
        shortLabel: contractId ? shortContractLabel(fullNumber, sectionToken) : NO_CONTRACT,
        fullLabel: fullNumber,
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
        label: brandId ? brandOptions.get(brandId) ?? normalizeText(attrs.engine_brand, brandId) : NO_BRAND,
        agg: emptyFlowAgg(),
      };
      contractNode.brands.set(brandKey, brandNode);
    }

    accFlow(brandNode.agg, delta);
    accFlow(contractNode.total, delta);
    accFlow(counterpartyNode.total, delta);
    accFlow(grand, delta);
  }

  const rows: Array<Record<string, ReportCellValue>> = [];
  const counterparties = Array.from(byCounterparty.entries()).sort((a, b) => a[1].label.localeCompare(b[1].label, 'ru'));
  for (const [counterpartyKey, counterpartyNode] of counterparties) {
    const contracts = Array.from(counterpartyNode.contracts.entries()).sort((a, b) => a[1].sortKey.localeCompare(b[1].sortKey, 'ru'));
    for (const [contractKey, contractNode] of contracts) {
      const brands = Array.from(contractNode.brands.values()).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      for (const brandNode of brands) {
        rows.push({
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
          _counterpartyKey: counterpartyKey,
          _contractKey: contractKey,
        });
      }
    }
  }

  const preset = getPreset('engine_flow_by_counterparty');
  const contractCount = counterparties.reduce((acc, [, node]) => acc + node.contracts.size, 0);
  const scrapPct = grand.arrived > 0 ? ((grand.scrapTotal / grand.arrived) * 100).toFixed(1) : '0.0';

  return {
    ok: true,
    presetId: preset.id,
    title: preset.title,
    subtitle: `Состояние на текущий момент · заказчиков: ${counterparties.length}, договоров: ${contractCount}`,
    columns: ENGINE_FLOW_BY_COUNTERPARTY_COLUMNS,
    rows,
    totals: {
      counterparties: counterparties.length,
      contracts: contractCount,
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
