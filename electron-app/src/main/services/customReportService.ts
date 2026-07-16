import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BrowserWindow } from 'electron';
import {
  applyCustomReportTransform,
  describeCustomReportFilters,
  sanitizeCustomReportSpec,
  CUSTOM_REPORT_SOURCE_PRESET_IDS,
  REPORT_PRESET_DEFINITIONS,
  type ReportCellValue,
  type ReportColumn,
  type ReportPresetPreviewResult,
} from '@matricarmz/shared';

import { buildReportByPreset } from './reportPresetService.js';
import type { ReportBuildContext } from './reportPresetService.js';

const PRESET_TITLES = new Map(REPORT_PRESET_DEFINITIONS.map((p) => [String(p.id), p.title]));

export type CustomReportRunResult =
  | {
      ok: true;
      title: string;
      subtitle: string;
      sourceTitle: string;
      columns: ReportColumn[];
      /** Full source column catalog — the builder UI picks from it. */
      sourceColumns: ReportColumn[];
      rows: Record<string, ReportCellValue>[];
      totals: Record<string, number> | null;
      rowCount: number;
      sourceRowCount: number;
      generatedAt: number;
    }
  | { ok: false; error: string };

export function listCustomReportSources(): Array<{ presetId: string; title: string }> {
  return CUSTOM_REPORT_SOURCE_PRESET_IDS.map((id) => ({ presetId: id, title: PRESET_TITLES.get(id) ?? id }));
}

export async function runCustomReport(
  db: BetterSQLite3Database,
  rawSpec: unknown,
  ctx?: ReportBuildContext,
): Promise<CustomReportRunResult> {
  const spec = sanitizeCustomReportSpec(rawSpec);
  if (!spec) return { ok: false, error: 'Некорректная спецификация отчёта' };
  const base: ReportPresetPreviewResult = await buildReportByPreset(
    db,
    { presetId: spec.sourcePresetId, filters: {} },
    ctx,
  );
  if (!base.ok) return base;
  const t = applyCustomReportTransform(base.columns, base.rows, spec);
  const filterText = describeCustomReportFilters(spec, base.columns);
  const sourceTitle = PRESET_TITLES.get(spec.sourcePresetId) ?? base.title;
  const subtitle = [
    `Источник: ${sourceTitle}`,
    filterText,
    `строк: ${t.rows.length} из ${t.sourceRowCount}`,
  ]
    .filter(Boolean)
    .join(' | ');
  return {
    ok: true,
    title: spec.title?.trim() || 'Свой отчёт',
    subtitle,
    sourceTitle,
    columns: t.columns,
    sourceColumns: base.columns,
    rows: t.rows,
    totals: t.totals,
    rowCount: t.rows.length,
    sourceRowCount: t.sourceRowCount,
    generatedAt: Date.now(),
  };
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatCellText(value: ReportCellValue): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return String(value);
}

export function renderCustomReportHtml(report: Extract<CustomReportRunResult, { ok: true }>): string {
  const headers = report.columns
    .map((c) => `<th style="text-align:${c.align === 'right' ? 'right' : 'left'}">${htmlEscape(c.label)}</th>`)
    .join('');
  const rows = report.rows
    .map((row) => {
      const tds = report.columns
        .map(
          (c) =>
            `<td style="text-align:${c.align === 'right' ? 'right' : 'left'}">${htmlEscape(formatCellText(row[c.key] ?? null))}</td>`,
        )
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  const totalsHtml = report.totals
    ? `<div class="totals"><b>Итого:</b> ${htmlEscape(
        report.columns
          .filter((c) => report.totals && report.totals[c.key] != null)
          .map((c) => `${c.label}: ${report.totals![c.key]}`)
          .join(', '),
      )}</div>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
body{font-family:Arial,sans-serif;font-size:13px;padding:16px;color:#0b1220}
h1{font-size:16px;margin:0 0 8px 0}
.meta{color:#475569;margin-bottom:10px;font-size:12px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #cbd5e1;padding:5px 6px;text-align:left;vertical-align:top}
th{background:#f1f5f9}
.totals{margin-top:10px;font-weight:700}
</style>
</head><body>
<h1>${htmlEscape(report.title)}</h1>
<div class="meta">${htmlEscape(report.subtitle)}</div>
<table><thead><tr>${headers}</tr></thead><tbody>${rows || `<tr><td colspan="${report.columns.length}">Нет данных</td></tr>`}</tbody></table>
${totalsHtml}
</body></html>`;
}

function csvEscape(value: string): string {
  return /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildCustomReportCsv(report: Extract<CustomReportRunResult, { ok: true }>): string {
  const lines = [report.columns.map((c) => csvEscape(c.label)).join(';')];
  for (const row of report.rows) {
    lines.push(report.columns.map((c) => csvEscape(formatCellText(row[c.key] ?? null))).join(';'));
  }
  if (report.totals) {
    lines.push('');
    lines.push(
      ['Итого', ...report.columns.filter((c) => report.totals![c.key] != null).map((c) => `${c.label}: ${report.totals![c.key]}`)]
        .map(csvEscape)
        .join(';'),
    );
  }
  return '﻿' + lines.join('\n') + '\n';
}

export async function printCustomReport(
  db: BetterSQLite3Database,
  rawSpec: unknown,
  ctx?: ReportBuildContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const report = await runCustomReport(db, rawSpec, ctx);
  if (!report.ok) return report;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderCustomReportHtml(report))}`);
    await new Promise<void>((resolve, reject) => {
      win.webContents.print({ printBackground: true }, (ok, errorType) => {
        if (!ok) return reject(new Error(errorType ?? 'print failed'));
        resolve();
      });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    win.destroy();
  }
}

export async function exportCustomReportCsv(
  db: BetterSQLite3Database,
  rawSpec: unknown,
  ctx?: ReportBuildContext,
): Promise<{ ok: true; csv: string; fileName: string; mime: string } | { ok: false; error: string }> {
  const report = await runCustomReport(db, rawSpec, ctx);
  if (!report.ok) return report;
  const spec = sanitizeCustomReportSpec(rawSpec);
  return {
    ok: true,
    csv: buildCustomReportCsv(report),
    fileName: `custom_${spec?.sourcePresetId ?? 'report'}_${new Date().toISOString().slice(0, 10)}.csv`,
    mime: 'text/csv;charset=utf-8',
  };
}
