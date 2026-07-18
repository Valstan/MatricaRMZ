
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  type ReportPresetPreviewRequest,
  type ReportPresetPreviewResult,
  } from '@matricarmz/shared';







import { buildPartsDemandReport, buildSupplyFulfillmentReport, buildPartMovementJournalReport, buildStockTurnoverReport, buildWorkshopThroughputReport, buildDefectReturnsSummaryReport, buildMovementIntegrityAuditReport, buildWarehouseStockPathAuditReport, buildSupplyReceiptGapReport } from './presets/warehouse.js';
import { buildEngineStagesReport, buildEngineMovementsReport, buildEnginesListReport, buildEngineReadinessToAssembleReport, buildScrapRegisterReport, buildEngineKittingReport } from './presets/engines.js';
import { buildContractsFinanceReport, buildContractsDeadlinesReport, buildContractsRequisitesReport } from './presets/contracts.js';
import { buildWorkOrderCostsReport, buildWorkOrdersReport, buildWorkOrderPayrollReport, buildWorkOrderPayrollSummaryReport } from './presets/workOrders.js';
import { buildEmployeesRosterReport, buildToolsInventoryReport, buildServicesPricelistReport, buildProductsCatalogReport, buildPartsCompatibilityReport, buildCounterpartiesSummaryReport } from './presets/catalogs.js';
import { buildAssemblyForecast7dReport } from './presets/assemblyForecast.js';
import { type ReportBuildContext } from './context.js';

export async function buildReportByPreset(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  try {
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
        return buildWorkOrdersReport(db, args.filters);
      case 'work_order_payroll':
        return buildWorkOrderPayrollReport(db, args.filters);
      case 'work_order_payroll_summary':
        return buildWorkOrderPayrollSummaryReport(db, args.filters);
      case 'employees_roster':
        return buildEmployeesRosterReport(db, args.filters);
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
      case 'engine_movements':
        return buildEngineMovementsReport(db, args.filters);
      case 'engines_list':
        return buildEnginesListReport(db, args.filters);
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
      case 'defect_returns_summary':
        return buildDefectReturnsSummaryReport(db, args.filters);
      case 'movement_integrity_audit':
        return buildMovementIntegrityAuditReport(db, args.filters);
      default:
        return { ok: false, error: `Неизвестный пресет: ${String(args.presetId)}` };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

