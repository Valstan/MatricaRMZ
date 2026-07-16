/**
 * Public facade of the report preset engine. The 5000-line monolith
 * (reportPresetService.ts) was split by layer:
 *   format.ts   — value/label formatters, totals metadata, filter matchers
 *   context.ts  — build context, EAV snapshot loader, shared caches
 *   options.ts  — filter option builders + getReportPresetList
 *   presets/    — one module per report domain (contracts, engines, work
 *                 orders, catalogs, warehouse, assembly forecast)
 *   dispatch.ts — buildReportByPreset switch
 *   render.ts   — HTML/CSV/1C-XML/PDF rendering, print
 * Behavior is intentionally identical; see the PR for the before/after
 * full-preset output diff.
 */
export { buildReportByPreset } from './dispatch.js';
export { getReportPresetList } from './options.js';
export type { ReportBuildContext } from './context.js';
export {
  buildReportCsv,
  buildReport1cXml,
  renderReportHtml,
  exportReportPresetPdf,
  exportReportPresetCsv,
  exportReportPreset1cXml,
  printReportPreset,
} from './render.js';

import { normalizeWorkOrderReportLines, normalizeWorkOrderReportCrew, resolveWorkOrderTargetLabel } from './presets/workOrders.js';

export const __reportPresetTestUtils = {
  normalizeWorkOrderReportLines,
  normalizeWorkOrderReportCrew,
  resolveWorkOrderTargetLabel,
};

