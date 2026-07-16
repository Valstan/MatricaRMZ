
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BrowserWindow } from 'electron';

import {
  type ReportCellValue,
  type ReportPreset1cXmlResult,
  type ReportPresetCsvResult,
  type ReportPresetId,
  type ReportPresetPdfResult,
  type ReportPresetPreviewRequest,
  type ReportPresetPrintResult,
  renderWorkOrdersReportHtml,
  } from '@matricarmz/shared';


import { formatRuMoney } from '../../utils/dateUtils.js';

import { prependUtf8Bom } from '../reportCsvEncoding.js';

import { renderWorkOrderPayrollFullHtml } from '../../../renderer/src/ui/utils/workOrderPayrollReportLayoutHtml.js';


import { labelTotalKey, formatTotalValue, formatTotalsForDisplay, formatTotalsGuide, csvEscape, htmlEscape, formatCell } from './format.js';
import { type OkPreview, type ReportBuildContext } from './context.js';
import { buildReportByPreset } from './dispatch.js';

export async function renderHtmlWindow(html: string) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      offscreen: true,
    },
  });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await win.loadURL(url);
  return win;
}


export function buildReportCsv(report: OkPreview): string {
  const header = report.columns.map((c) => csvEscape(c.label)).join(';');
  const lines = [header];
  for (const row of report.rows) {
    lines.push(report.columns.map((column) => csvEscape(formatCell(column, (row[column.key] ?? null) as ReportCellValue))).join(';'));
  }
  if (report.totals && Object.keys(report.totals).length > 0) {
    lines.push('');
    lines.push(['Итого по отчету', ...formatTotalsForDisplay(report.totals)].map(csvEscape).join(';'));
  }
  return prependUtf8Bom(lines.join('\n') + '\n');
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildReport1cXml(report: OkPreview): string {
  const generatedAtIso = new Date(report.generatedAt).toISOString();
  const columnsXml = report.columns
    .map(
      (column) =>
        `      <Колонка><Ключ>${xmlEscape(column.key)}</Ключ><Наименование>${xmlEscape(column.label)}</Наименование><Тип>${xmlEscape(
          column.kind ?? 'text',
        )}</Тип></Колонка>`,
    )
    .join('\n');
  const rowsXml = report.rows
    .map((row) => {
      const fields = report.columns
        .map((column) => {
          const raw = row[column.key] ?? null;
          const text = formatCell(column, raw as ReportCellValue);
          return `        <Поле><Ключ>${xmlEscape(column.key)}</Ключ><Значение>${xmlEscape(text)}</Значение></Поле>`;
        })
        .join('\n');
      return `      <Строка>\n${fields}\n      </Строка>`;
    })
    .join('\n');
  const totalsXml =
    report.totals && Object.keys(report.totals).length > 0
      ? Object.entries(report.totals)
          .map(([key, value]) => {
            const label = labelTotalKey(key);
            return `      <Итог><Ключ>${xmlEscape(key)}</Ключ><Наименование>${xmlEscape(label)}</Наименование><Значение>${xmlEscape(
              formatTotalValue(key, value),
            )}</Значение></Итог>`;
          })
          .join('\n')
      : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<КоммерческаяИнформация ВерсияСхемы="2.10">',
    '  <Отчет>',
    `    <ИдПресета>${xmlEscape(report.presetId)}</ИдПресета>`,
    `    <Наименование>${xmlEscape(report.title)}</Наименование>`,
    `    <Подзаголовок>${xmlEscape(report.subtitle ?? '')}</Подзаголовок>`,
    `    <ДатаФормирования>${xmlEscape(generatedAtIso)}</ДатаФормирования>`,
    '    <Колонки>',
    columnsXml,
    '    </Колонки>',
    '    <Строки>',
    rowsXml || '      <Строка />',
    '    </Строки>',
    '    <Итоги>',
    totalsXml || '      <Итог />',
    '    </Итоги>',
    '  </Отчет>',
    '</КоммерческаяИнформация>',
    '',
  ].join('\n');
}

export function assemblyForecastPdfStatusClass(statusText: string): string {
  if (statusText === 'Комплект') return 'afp-st-ok';
  if (statusText === 'Неполный комплект') return 'afp-st-wait';
  if (statusText === 'Нет') return 'afp-st-bad';
  if (statusText === 'Выходной') return 'afp-st-neu';
  if (statusText === 'Хватает') return 'afp-st-ok';
  if (statusText === 'Частично') return 'afp-st-wait';
  if (statusText === 'Не хватает') return 'afp-st-bad';
  return 'afp-st-neu';
}

export function renderAssemblyForecastPdfBlocks(report: OkPreview): string {
  const style = `<style>
.afp-wrap{font-size:14px;color:#0b1220}
.afp-day-list{display:block}
.afp-day{border:1px solid #cbd5e1;border-radius:10px;overflow:hidden;background:#fff;margin-bottom:12px}
.afp-day:last-child{margin-bottom:0}
.afp-day-head{padding:10px 12px;font-weight:800;font-size:15px;background:linear-gradient(180deg,#f8fafc,#eef2f7);border-bottom:1px solid #cbd5e1}
.afp-day-body{padding:8px 10px}
.afp-engine{border:1px solid #e2e8f0;border-radius:8px;background:#fff;margin-bottom:8px;overflow:hidden}
.afp-engine:last-child{margin-bottom:0}
.afp-engine-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:#f8fafc;border-bottom:1px solid #e2e8f0}
.afp-engine-brand{font-weight:700;font-size:14px;color:#0f172a}
.afp-engine-parts{padding:8px 10px;background:#fff}
.afp-st{display:inline-block;padding:2px 9px;border-radius:999px;font-size:14px;font-weight:800;letter-spacing:0.03em;border:1px solid transparent}
.afp-st-ok{background:rgba(22,163,74,0.14);color:#14532d;border-color:rgba(22,163,74,0.35)}
.afp-st-wait{background:rgba(217,119,6,0.16);color:#7c2d12;border-color:rgba(217,119,6,0.4)}
.afp-st-bad{background:rgba(220,38,38,0.12);color:#7f1d1d;border-color:rgba(220,38,38,0.35)}
.afp-st-neu{background:#f8fafc;color:#475569;border-color:#e2e8f0}
.afp-engine-part{padding:5px 0 5px 8px;margin-bottom:5px;border-left:2px solid rgba(37,99,235,0.35);background:rgba(248,250,252,0.95);border-radius:0 6px 6px 0;line-height:1.45}
.afp-engine-part:last-child{margin-bottom:0}
.afp-empty{padding:12px;text-align:center;color:#64748b;border:1px dashed #cbd5e1;border-radius:10px;background:#fff}
</style>`;
  const statusCol = report.columns.find((c) => c.key === 'status');
  const dayCol = report.columns.find((c) => c.key === 'dayLabel');
  const brandCol = report.columns.find((c) => c.key === 'engineBrand');
  const compCol = report.columns.find((c) => c.key === 'requiredComponentsSummary');
  const rows = report.rows.map((row) => {
    const status = formatCell(statusCol ?? { key: 'status', label: '', kind: 'text' }, (row['status'] ?? null) as ReportCellValue);
    const dayLabel = formatCell(dayCol ?? { key: 'dayLabel', label: '', kind: 'text' }, (row['dayLabel'] ?? null) as ReportCellValue);
    const engineBrand = formatCell(brandCol ?? { key: 'engineBrand', label: '', kind: 'text' }, (row['engineBrand'] ?? null) as ReportCellValue);
    const partsRaw = formatCell(
      compCol ?? { key: 'requiredComponentsSummary', label: '', kind: 'text' },
      (row['requiredComponentsSummary'] ?? null) as ReportCellValue,
    );
    const parts = partsRaw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const statusCode = String((row as Record<string, unknown>)['_assemblyStatusCode'] ?? '');
    return { dayLabel, engineBrand, status, statusCode, parts };
  });
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const dayRows = byDay.get(row.dayLabel) ?? [];
    dayRows.push(row);
    byDay.set(row.dayLabel, dayRows);
  }
  const daySections =
    rows.length > 0
      ? Array.from(byDay.entries())
          .map(([dayLabel, dayRows]) => {
            const engineHtml = dayRows
              .map((r) => {
                const statusClass = assemblyForecastPdfStatusClass(r.status);
                const partsHtml =
                  r.parts.length > 0
                    ? `<div class="afp-engine-parts">${r.parts
                        .map((line) => `<div class="afp-engine-part">${htmlEscape(line)}</div>`)
                        .join('')}</div>`
                    : '';
                return `<article class="afp-engine"><div class="afp-engine-head"><div class="afp-engine-brand">${htmlEscape(r.engineBrand)}</div><span class="afp-st ${statusClass}">${htmlEscape(r.status)}</span></div>${partsHtml}</article>`;
              })
              .join('');
            return `<section class="afp-day"><div class="afp-day-head">${htmlEscape(dayLabel)}</div><div class="afp-day-body">${engineHtml}</div></section>`;
          })
          .join('')
      : `<div class="afp-empty">Нет данных</div>`;
  return `${style}<div class="afp-wrap"><div class="afp-day-list">${daySections}</div></div>`;
}

export function renderAssemblyForecastPdfFooter(lines: string[]): string {
  const style = `<style>
.afp-fn{border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;margin-top:12px}
.afp-fn-h{padding:8px 12px;font-weight:800;font-size:14px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;background:linear-gradient(180deg,#f1f5f9,#f8fafc);border-bottom:1px solid #e2e8f0}
.afp-fn-line{padding:7px 12px;font-size:14px;line-height:1.45;color:#475569;border-bottom:1px solid #f1f5f9}
.afp-fn-line:last-child{border-bottom:none}
.afp-fn-lead{margin:8px 10px 4px;padding:7px 10px;font-weight:800;font-size:14px;color:#0b1220;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px}
.afp-fn-bul{padding-left:20px;position:relative}
.afp-fn-bul:before{content:'';position:absolute;left:10px;top:0.85em;width:4px;height:4px;border-radius:50%;background:#94a3b8}
</style>`;
  const LEAD = [
    'Недовыпуск',
    'Комплектующие:',
    'Чтобы закрыть',
    'Марки без',
    'Контракт «',
    'Авто-приоритет',
    'Авто: нет контрактов',
    'Приоритет:',
    'Приоритетные марки',
    'Ограничение:',
  ];
  const body = lines
    .map((line) => {
      const t = line.trim();
      if (t.startsWith('•')) {
        return `<div class="afp-fn-line afp-fn-bul">${htmlEscape(line)}</div>`;
      }
      if (LEAD.some((p) => t.startsWith(p))) {
        return `<div class="afp-fn-lead">${htmlEscape(line)}</div>`;
      }
      return `<div class="afp-fn-line">${htmlEscape(line)}</div>`;
    })
    .join('');
  return `${style}<div class="afp-fn"><div class="afp-fn-h">Пояснения</div>${body}</div>`;
}

export function renderReportHtml(report: OkPreview): string {
  if (report.presetId === 'work_order_payroll') {
    return renderWorkOrderPayrollFullHtml(report);
  }
  if (report.presetId === 'assembly_forecast_7d') {
    const subtitleChips = (report.subtitle ?? '')
      .split(' | ')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(
        (chunk) =>
          `<span style="display:inline-block;margin:3px 4px 0 0;padding:4px 9px;border-radius:999px;border:1px solid #e2e8f0;background:#f8fafc;font-size:14px;color:#475569">${htmlEscape(chunk)}</span>`,
      )
      .join('');
    const metaHtml = subtitleChips
      ? `<div style="margin:0 0 12px 0;line-height:1.4">${subtitleChips}</div>`
      : `<div class="meta">${htmlEscape(report.subtitle ?? '')}</div>`;
    const tableBlock = renderAssemblyForecastPdfBlocks(report);
    const totalsHtml =
      report.totals && Object.keys(report.totals).length > 0
        ? `<div style="margin-top:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-size:14px"><b>Итого по отчёту:</b> ${htmlEscape(formatTotalsForDisplay(report.totals).join(', '))}</div>`
        : '';
    const footerNotesHtml =
      report.footerNotes && report.footerNotes.length > 0 ? renderAssemblyForecastPdfFooter(report.footerNotes) : '';
    return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:14px;padding:16px;color:#0b1220}
h1{font-size:16px;margin:0 0 8px 0}
</style>
</head><body>
<h1>${htmlEscape(report.title)}</h1>
${metaHtml}
${tableBlock}
${totalsHtml}
${footerNotesHtml}
</body></html>`;
  }
  if (report.presetId === 'work_orders_report') {
    const chips = (report.subtitle ?? '')
      .split(' | ')
      .map((s) => s.trim())
      .filter(Boolean);
    const totalsLine = report.totals
      ? `Нарядов: ${Math.round(Number(report.totals.orders ?? 0))} · Сумма: ${formatRuMoney(Number(report.totals.amountRub ?? 0))}`
      : undefined;
    return renderWorkOrdersReportHtml({
      title: report.title,
      subtitleChips: chips,
      columns: report.columns,
      rows: report.rows,
      ...(totalsLine ? { totalsLine } : {}),
      ...(report.workOrdersStatusSummary ? { statusSummary: report.workOrdersStatusSummary } : {}),
    });
  }
  const headers = report.columns.map((c) => `<th style="text-align:${c.align === 'right' ? 'right' : 'left'}">${htmlEscape(c.label)}</th>`).join('');
  const rows = report.rows
    .map((row) => {
      const tds = report.columns
        .map((column) => {
          const text = formatCell(column, (row[column.key] ?? null) as ReportCellValue);
          return `<td style="text-align:${column.align === 'right' ? 'right' : 'left'}">${htmlEscape(text)}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  const totalsByGroupHtml =
    report.totalsByGroup && report.totalsByGroup.length > 0
      ? `<div class="group"><b>Итоги по группам (ключевые метрики):</b><ul>${report.totalsByGroup
          .map((g) => `<li>${htmlEscape(g.group)}: ${htmlEscape(formatTotalsForDisplay(g.totals).join(', '))}</li>`)
          .join('')}</ul></div>`
      : '';
  const totalsGuideHtml = report.totals && Object.keys(report.totals).length > 0 ? formatTotalsGuide(report.totals) : '';
  const totalsHtml =
    report.totals && Object.keys(report.totals).length > 0
      ? `<div class="totals"><b>Итого по отчету:</b> ${htmlEscape(formatTotalsForDisplay(report.totals).join(', '))}</div>`
      : '';
  const footerNotesHtml =
    report.footerNotes && report.footerNotes.length > 0
      ? `<div class="footer-notes"><b>Пояснения</b><ul>${report.footerNotes.map((n) => `<li>${htmlEscape(n)}</li>`).join('')}</ul></div>`
      : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
body{font-family:Arial,sans-serif;font-size:14px;padding:16px;color:#0b1220}
h1{font-size:16px;margin:0 0 8px 0}
.meta{color:#475569;margin-bottom:10px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #e5e7eb;padding:6px;text-align:left;vertical-align:top}
th{background:#f1f5f9}
.totals{margin-top:10px;font-weight:700}
.group{margin:8px 0 12px 0}
.group ul{margin:6px 0 0 18px;padding:0}
.metrics-guide{margin-top:12px;padding:10px;border:1px solid #e2e8f0;background:#f8fafc}
.footer-notes{margin-top:14px;padding:10px;border:1px solid #e5e7eb;border-radius:6px}
.footer-notes ul{margin:8px 0 0 18px;padding:0}
</style>
</head><body>
<h1>${htmlEscape(report.title)}</h1>
<div class="meta">${htmlEscape(report.subtitle ?? '')}</div>
${totalsByGroupHtml}
<table><thead><tr>${headers}</tr></thead><tbody>${rows || `<tr><td colspan="${report.columns.length}">Нет данных</td></tr>`}</tbody></table>
${totalsHtml}
${totalsGuideHtml}
${footerNotesHtml}
</body></html>`;
}

export function buildFileBaseName(presetId: ReportPresetId): string {
  return `${presetId}_${new Date().toISOString().slice(0, 10)}`;
}

export async function exportReportPresetPdf(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPdfResult> {
  const report = await buildReportByPreset(db, args, ctx);
  if (!report.ok) return report;
  const html = renderReportHtml(report);
  const win = await renderHtmlWindow(html);
  try {
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    return {
      ok: true,
      contentBase64: Buffer.from(pdf).toString('base64'),
      fileName: `${buildFileBaseName(args.presetId)}.pdf`,
      mime: 'application/pdf',
    };
  } finally {
    win.destroy();
  }
}

export async function exportReportPresetCsv(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPresetCsvResult> {
  const report = await buildReportByPreset(db, args, ctx);
  if (!report.ok) return report;
  return {
    ok: true,
    csv: buildReportCsv(report),
    fileName: `${buildFileBaseName(args.presetId)}.csv`,
    mime: 'text/csv;charset=utf-8',
  };
}

export async function exportReportPreset1cXml(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPreset1cXmlResult> {
  const report = await buildReportByPreset(db, args, ctx);
  if (!report.ok) return report;
  return {
    ok: true,
    xml: buildReport1cXml(report),
    fileName: `${buildFileBaseName(args.presetId)}.xml`,
    mime: 'application/xml;charset=utf-8',
  };
}

export async function printReportPreset(
  db: BetterSQLite3Database,
  args: ReportPresetPreviewRequest,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPrintResult> {
  const report = await buildReportByPreset(db, args, ctx);
  if (!report.ok) return report;
  const html = renderReportHtml(report);
  const win = await renderHtmlWindow(html);
  try {
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

