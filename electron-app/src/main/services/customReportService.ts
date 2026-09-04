import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BrowserWindow } from 'electron';
import {
  applyCustomReportTransform,
  CustomReportSpecMismatchError,
  describeCustomReportFilters,
  sanitizeCustomReportSpec,
  CUSTOM_REPORT_AGG_LABELS_RU,
  CUSTOM_REPORT_SOURCE_PRESET_IDS,
  REPORT_PRESET_DEFINITIONS,
  resolveReportPresetId,
  type CustomReportGroup,
  type CustomReportSpecV1,
  type ReportCellValue,
  type ReportColumn,
  type ReportPresetPreviewResult,
} from '@matricarmz/shared';

import { formatCell } from './reports/format.js';
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
      groups: CustomReportGroup[] | null;
      groupByLabel: string | null;
      /** Тип колонки разреза: заголовок группы форматируется им же, чем и ячейка. */
      groupByKind: ReportColumn['kind'] | null;
      /** Chosen aggregate per column (for labels in totals). */
      aggs: CustomReportSpecV1['aggs'] | null;
      rowCount: number;
      sourceRowCount: number;
      generatedAt: number;
    }
  | { ok: false; error: string };

export function listCustomReportSources(): Array<{ presetId: string; title: string }> {
  // Название ищем по каноническому id: `engines_list` объединён в `engines` (#647), своего
  // определения у него больше нет, и прежний фолбэк `?? id` показывал оператору служебный код
  // среди русских названий. Сам presetId — хранимый ключ шаблона, его подменять нельзя.
  return CUSTOM_REPORT_SOURCE_PRESET_IDS.map((id) => ({
    presetId: id,
    title: PRESET_TITLES.get(resolveReportPresetId(id)) ?? PRESET_TITLES.get(id) ?? id,
  }));
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
  let t: ReturnType<typeof applyCustomReportTransform>;
  try {
    t = applyCustomReportTransform(base.columns, base.rows, spec);
  } catch (e) {
    // Шаблон разошёлся с источником — честный отказ вместо чужого разреза под его именем.
    if (e instanceof CustomReportSpecMismatchError) return { ok: false, error: e.message };
    throw e;
  }
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
    groups: t.groups,
    groupByLabel: t.groupByLabel,
    groupByKind: t.groupByKind,
    aggs: spec.aggs ?? null,
    rowCount: t.rows.length,
    sourceRowCount: t.sourceRowCount,
    generatedAt: Date.now(),
  };
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Своего форматтера здесь нет намеренно: `String(value)` печатал даты миллисекундами.
// Взят сборщик отчётов main-процесса — тот же, что форматирует все прочие отчёты; общий с
// рендерером модуль сюда не годится, он тянет за собой Blob и document.
function formatCellText(column: ReportColumn, value: ReportCellValue): string {
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return formatCell(column, value ?? null);
}

/**
 * Подпись заголовка группы. Берётся из СЫРОГО значения и типа колонки разреза, а не из
 * `g.value`: тот — ключ разреза, и у колонки-даты это epoch в миллисекундах. Печать, CSV и
 * экран обязаны говорить одинаково, поэтому подпись считается одной функцией на все три.
 */
function groupHeaderText(report: Extract<CustomReportRunResult, { ok: true }>, group: CustomReportGroup): string {
  const kind = report.groupByKind ?? 'text';
  const shown = formatCellText({ key: 'group', label: '', kind }, group.rawValue) || group.value;
  return `${report.groupByLabel ?? ''}: ${shown}`;
}

function totalsText(report: Extract<CustomReportRunResult, { ok: true }>, totals: Record<string, number>): string {
  return report.columns
    .filter((c) => totals[c.key] != null)
    .map((c) => {
      const fn = report.aggs?.[c.key] ?? 'sum';
      const suffix = fn === 'sum' ? '' : ` (${CUSTOM_REPORT_AGG_LABELS_RU[fn]})`;
      return `${c.label}${suffix}: ${totals[c.key]}`;
    })
    .join(', ');
}

export function renderCustomReportHtml(report: Extract<CustomReportRunResult, { ok: true }>): string {
  const headers = report.columns
    .map((c) => `<th style="text-align:${c.align === 'right' ? 'right' : 'left'}">${htmlEscape(c.label)}</th>`)
    .join('');
  const rowHtml = (row: Record<string, ReportCellValue>) => {
    const tds = report.columns
      .map(
        (c) =>
          `<td style="text-align:${c.align === 'right' ? 'right' : 'left'}">${htmlEscape(formatCellText(c, row[c.key] ?? null))}</td>`,
      )
      .join('');
    return `<tr>${tds}</tr>`;
  };
  const colCount = report.columns.length;
  const rows = report.groups
    ? report.groups
        .map((g) => {
          const header = `<tr class="grp"><td colspan="${colCount}"><b>${htmlEscape(groupHeaderText(report, g))}</b> (${g.count})</td></tr>`;
          const body = g.rows.map(rowHtml).join('');
          const sub = g.totals
            ? `<tr class="sub"><td colspan="${colCount}">Итого по группе: ${htmlEscape(totalsText(report, g.totals))}</td></tr>`
            : '';
          return header + body + sub;
        })
        .join('')
    : report.rows.map(rowHtml).join('');
  const totalsHtml = report.totals
    ? `<div class="totals"><b>Итого:</b> ${htmlEscape(totalsText(report, report.totals))}</div>`
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
tr.grp td{background:#e2e8f0}
tr.sub td{background:#f8fafc;font-style:italic}
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
  const pushRow = (row: Record<string, ReportCellValue>) =>
    lines.push(report.columns.map((c) => csvEscape(formatCellText(c, row[c.key] ?? null))).join(';'));
  if (report.groups) {
    for (const g of report.groups) {
      lines.push(csvEscape(`${groupHeaderText(report, g)} (${g.count})`));
      for (const row of g.rows) pushRow(row);
      if (g.totals) lines.push(csvEscape(`Итого по группе: ${totalsText(report, g.totals)}`));
    }
  } else {
    for (const row of report.rows) pushRow(row);
  }
  if (report.totals) {
    lines.push('');
    lines.push(['Итого', totalsText(report, report.totals)].map(csvEscape).join(';'));
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
