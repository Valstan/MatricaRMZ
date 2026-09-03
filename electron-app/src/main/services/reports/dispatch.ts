
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  type ReportPresetPreviewRequest,
  type ReportPresetPreviewResult,
  } from '@matricarmz/shared';







import { buildPartsDemandReport, buildSupplyFulfillmentReport, buildPartMovementJournalReport, buildStockTurnoverReport, buildWorkshopThroughputReport, buildDefectReturnsSummaryReport, buildMovementIntegrityAuditReport, buildWarehouseStockPathAuditReport, buildSupplyReceiptGapReport, buildRepairFundReconciliationReport } from './presets/warehouse.js';
import { buildEngineStagesReport, buildEnginesReport, buildEnginesListReport, buildEnginesContractsOverviewReport, buildEngineReadinessToAssembleReport, buildScrapRegisterReport, buildEngineKittingReport, buildNormsPurchasePlanReport } from './presets/engines.js';
import { buildContractsFinanceReport, buildContractsDeadlinesReport, buildContractsRequisitesReport } from './presets/contracts.js';
import { buildWorkOrderCostsReport, buildWorkOrdersReport, buildWorkOrderPayrollReport, buildWorkOrderPayrollSummaryReport } from './presets/workOrders.js';
import { buildEmployeesRosterReport, buildOrganizationStructureReport, buildToolsInventoryReport, buildServicesPricelistReport, buildProductsCatalogReport, buildPartsCompatibilityReport, buildCounterpartiesSummaryReport } from './presets/catalogs.js';
import { buildEngineFlowByCounterpartyReport } from './presets/engineFlowByCounterparty.js';
import { buildAssemblyForecast7dReport } from './presets/assemblyForecast.js';
import { buildContractPaymentsMatrixReport, buildPaymentsOverviewReport } from './presets/payments.js';
import { app } from 'electron';

import { appendMainLogLine } from '../../utils/logger.js';
import { type ReportBuildContext } from './context.js';

export async function buildReportByPreset(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  try {
    // Именно `await`, а не `return` из switch: без него отклонённое обещание билдера
    // проходит мимо catch, и оператор получал в шапку экрана текст SqliteError.
    return await dispatchReportPreset(db, args, ctx);
  } catch (e) {
    appendMainLogLine(app, `reports: пресет ${String(args.presetId)} упал — ${String(e)}`);
    return { ok: false, error: 'Не удалось построить отчёт' };
  }
}

async function dispatchReportPreset(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  {
    switch (args.presetId) {
      case 'parts_demand':
        return buildPartsDemandReport(db, args.filters);
      case 'engine_stages':
        return buildEngineStagesReport(db, args.filters);
      case 'contracts_finance':
        return buildContractsFinanceReport(db, args.filters);
      case 'contracts_deadlines':
        return buildContractsDeadlinesReport(db, args.filters);
      case 'contracts_requisites':
        return buildContractsRequisitesReport(db, args.filters);
      case 'supply_fulfillment':
        return buildSupplyFulfillmentReport(db, args.filters);
      case 'work_order_costs':
        return buildWorkOrderCostsReport(db, args.filters);
      case 'work_orders_report':
        return buildWorkOrdersReport(db, args.filters, ctx);
      case 'work_order_payroll':
        return buildWorkOrderPayrollReport(db, args.filters);
      case 'work_order_payroll_summary':
        return buildWorkOrderPayrollSummaryReport(db, args.filters, ctx);
      case 'employees_roster':
        return buildEmployeesRosterReport(db, args.filters, ctx);
      case 'organization_structure':
        return buildOrganizationStructureReport(db, args.filters, ctx);
      case 'tools_inventory':
        return buildToolsInventoryReport(db, args.filters);
      case 'services_pricelist':
        return buildServicesPricelistReport(db, args.filters);
      case 'products_catalog':
        return buildProductsCatalogReport(db);
      case 'parts_compatibility':
        return buildPartsCompatibilityReport(db, args.filters);
      case 'counterparties_summary':
        return buildCounterpartiesSummaryReport(db, args.filters);
      case 'engines':
        return buildEnginesReport(db, args.filters);
      // Алиасы прежних отчётов (этап 6, 19.08б): сохранённые ссылки и шаблоны
      // продолжают работать, каталог показывает только объединённый «Двигатели».
      case 'engines_list':
        return buildEnginesListReport(db, args.filters);
      case 'engines_contracts_overview':
        return buildEnginesContractsOverviewReport(db, args.filters);
      case 'engine_flow_by_counterparty':
        return buildEngineFlowByCounterpartyReport(db, args.filters);
      case 'scrap_register':
        return buildScrapRegisterReport(db, args.filters);
      case 'warehouse_stock_path_audit':
        return buildWarehouseStockPathAuditReport(db, args.filters);
      case 'assembly_forecast_7d':
        return buildAssemblyForecast7dReport(db, args.filters, ctx);
      case 'part_movement_journal':
        return buildPartMovementJournalReport(db, args.filters, ctx);
      case 'stock_turnover':
        return buildStockTurnoverReport(db, args.filters, ctx);
      case 'workshop_throughput':
        return buildWorkshopThroughputReport(db, args.filters, ctx);
      case 'engine_readiness_to_assemble':
        return buildEngineReadinessToAssembleReport(db, args.filters, ctx);
      case 'engine_kitting':
        return buildEngineKittingReport(db, args.filters, ctx);
      case 'supply_receipt_gap':
        return buildSupplyReceiptGapReport(db, args.filters, ctx);
      case 'norms_purchase_plan':
        return buildNormsPurchasePlanReport(db, args.filters, ctx);
      case 'repair_fund_reconciliation':
        return buildRepairFundReconciliationReport(db, args.filters, ctx);
      case 'defect_returns_summary':
        return buildDefectReturnsSummaryReport(db, args.filters);
      case 'movement_integrity_audit':
        return buildMovementIntegrityAuditReport(db, args.filters);
      case 'contract_payments_matrix':
        return buildContractPaymentsMatrixReport(db, args.filters);
      case 'payments_overview':
        return buildPaymentsOverviewReport(db, args.filters);
      default:
        // Оператор мог прийти сюда по ярлыку на снятый отчёт. Называть конкретную замену
        // нельзя — пресет мог быть складским или платёжным; отправляем в каталог.
        appendMainLogLine(app, `reports: запрошен неизвестный пресет ${String(args.presetId)}`);
        return { ok: false, error: 'Этот отчёт больше не выпускается — выберите другой в каталоге отчётов' };
    }
  }
}

