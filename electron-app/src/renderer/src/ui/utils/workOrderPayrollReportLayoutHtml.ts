import type { ReportCellValue, ReportColumn, ReportPresetPreviewResult } from '@matricarmz/shared';

import { formatMoscowDate, formatMoscowDateTime, formatRuMoney, formatRuNumber, formatRuPercent } from './dateUtils.js';
import { escapeHtml } from './printPreview.js';

function formatPayrollTableCell(column: ReportColumn, value: ReportCellValue): string {
  if (value == null) return '';
  const kind = column.kind ?? 'text';
  if (kind === 'date' && typeof value === 'number') return formatMoscowDate(value);
  if (kind === 'datetime' && typeof value === 'number') return formatMoscowDateTime(value);
  if (kind === 'number' && typeof value === 'number') {
    const key = String(column.key).toLowerCase();
    if (key.includes('pct') || key.includes('progress')) {
      return formatRuPercent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    }
    if (key.includes('amount') || key.includes('sum') || key.includes('rub')) {
      return formatRuMoney(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return formatRuNumber(value, { maximumFractionDigits: 2 });
  }
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return String(value);
}

type PreviewOk = Extract<ReportPresetPreviewResult, { ok: true }>;

export function collectPayrollEmployeeNames(report: PreviewOk): string[] {
  const set = new Set<string>();
  for (const row of report.rows) {
    const name = String(row.employeeName ?? '').trim();
    if (name) set.add(name);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
}

function resolvePayrollAccrualTotalRub(report: PreviewOk): number {
  if (typeof report.payrollAccrualTotalRub === 'number' && Number.isFinite(report.payrollAccrualTotalRub)) {
    return report.payrollAccrualTotalRub;
  }
  return report.rows.reduce((acc, r) => acc + (typeof r.amountRub === 'number' ? r.amountRub : Number(r.amountRub) || 0), 0);
}

const PAYROLL_PRINT_STYLES = `
body{font-family:Arial,sans-serif;font-size:14px;padding:16px;color:#0b1220}
.payroll-doc{max-width:900px;margin:0 auto}
.payroll-hero{font-size:18px;font-weight:700;margin:12px 0 16px 0;line-height:1.3}
.payroll-block-title{font-weight:700;margin:16px 0 8px 0;font-size:14px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #e5e7eb;padding:6px;text-align:left;vertical-align:top}
th{background:#f1f5f9}
.payroll-total{margin-top:12px;font-weight:700;font-size:14px}
.payroll-formula{margin-top:6px;font-size:14px;color:#475569}
.payroll-sig{margin-top:28px;display:grid;gap:14px}
.payroll-sig-row{display:flex;gap:12px;align-items:flex-end;justify-content:space-between}
.payroll-sig-row span:first-child{white-space:nowrap;color:#334155}
.payroll-sig-line{flex:1;border-bottom:1px solid #0f172a;min-height:18px}
h1{font-size:16px;margin:0 0 8px 0}
.meta{color:#475569;margin-bottom:10px}
@media print{
  body{padding:10mm}
  .payroll-works tr,.payroll-main tr{break-inside:avoid-page}
  .payroll-sig{break-inside:avoid-page}
}
`;

/** Полный HTML-документ для печати/PDF из main process (`renderReportHtml`). */
export function renderWorkOrderPayrollFullHtml(report: PreviewOk): string {
  if (report.presetId !== 'work_order_payroll') {
    throw new Error('renderWorkOrderPayrollFullHtml: expected work_order_payroll');
  }
  const names = collectPayrollEmployeeNames(report);
  const hero =
    names.length === 0 ? 'Сотрудники: (нет строк начислений)' : names.length === 1 ? names[0]! : `Сотрудники: ${names.join(', ')}`;

  const totalRub = resolvePayrollAccrualTotalRub(report);
  const lines = report.payrollWorkLines ?? [];

  const headers = report.columns
    .map((c) => `<th style="text-align:${c.align === 'right' ? 'right' : 'left'}">${escapeHtml(c.label)}</th>`)
    .join('');
  const mainBody =
    report.rows.length > 0
      ? report.rows
          .map((row) => {
            const tds = report.columns
              .map((column) => {
                const text = formatPayrollTableCell(column, (row[column.key] ?? null) as ReportCellValue);
                return `<td style="text-align:${column.align === 'right' ? 'right' : 'left'}">${escapeHtml(text)}</td>`;
              })
              .join('');
            return `<tr>${tds}</tr>`;
          })
          .join('')
      : `<tr><td colspan="${report.columns.length}">Нет данных</td></tr>`;

  const worksBody =
    lines.length > 0
      ? lines
          .map((line) => {
            const dateStr = formatMoscowDate(line.orderDateMs);
            const qtyStr = formatRuNumber(line.qty, { maximumFractionDigits: 3 });
            const priceStr = formatRuMoney(line.priceRub, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
            const amountStr = formatRuMoney(line.amountRub, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            return `<tr>
  <td>${escapeHtml(dateStr)}</td>
  <td>${escapeHtml(line.workLabel)}</td>
  <td style="text-align:right">${escapeHtml(qtyStr)}</td>
  <td style="text-align:right">${escapeHtml(priceStr)}</td>
  <td style="text-align:right">${escapeHtml(amountStr)}</td>
</tr>`;
          })
          .join('')
      : `<tr><td colspan="5">Нет строк работ по отобранным нарядам</td></tr>`;

  const totalStr = formatRuNumber(totalRub, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const signatures = `
<div class="payroll-sig">
  <div class="payroll-sig-row"><span>Работник</span><span class="payroll-sig-line"></span></div>
  <div class="payroll-sig-row"><span>Проверил (мастер / бригадир)</span><span class="payroll-sig-line"></span></div>
  <div class="payroll-sig-row"><span>Главный бухгалтер</span><span class="payroll-sig-line"></span></div>
  <div class="payroll-sig-row"><span>Руководитель</span><span class="payroll-sig-line"></span></div>
</div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>${PAYROLL_PRINT_STYLES}</style>
</head><body>
<div class="payroll-doc">
<h1>${escapeHtml(report.title)}</h1>
<div class="meta">${escapeHtml(report.subtitle ?? '')}</div>
<div class="payroll-hero">${escapeHtml(hero)}</div>
<div class="payroll-block-title">Данные отчета</div>
<table class="payroll-main"><thead><tr>${headers}</tr></thead><tbody>${mainBody}</tbody></table>
<div class="payroll-block-title">Виды работ по нарядам</div>
<table class="payroll-works">
<thead><tr>
  <th>Дата</th>
  <th>Вид работы</th>
  <th style="text-align:right">Количество</th>
  <th style="text-align:right">Цена</th>
  <th style="text-align:right">Сумма</th>
</tr></thead>
<tbody>${worksBody}</tbody>
</table>
<div class="payroll-total">Итог: ${escapeHtml(totalStr)} ₽</div>
<div class="payroll-formula">Итог совпадает с суммой колонки «Начислено (руб)» по отфильтрованным строкам таблицы выше.</div>
${signatures}
</div>
</body></html>`;
}

/** Фрагмент HTML для окна предпросмотра (без обёртки документа): блок формы без дублирования внешнего заголовка окна. */
export function renderWorkOrderPayrollFormInnerHtml(report: PreviewOk): string {
  if (report.presetId !== 'work_order_payroll') {
    throw new Error('renderWorkOrderPayrollFormInnerHtml: expected work_order_payroll');
  }
  const names = collectPayrollEmployeeNames(report);
  const hero =
    names.length === 0 ? 'Сотрудники: (нет строк начислений)' : names.length === 1 ? names[0]! : `Сотрудники: ${names.join(', ')}`;

  const totalRub = resolvePayrollAccrualTotalRub(report);
  const lines = report.payrollWorkLines ?? [];

  const headers = report.columns
    .map((c) => `<th style="text-align:${c.align === 'right' ? 'right' : 'left'}">${escapeHtml(c.label)}</th>`)
    .join('');
  const mainBody =
    report.rows.length > 0
      ? report.rows
          .map((row) => {
            const tds = report.columns
              .map((column) => {
                const text = formatPayrollTableCell(column, (row[column.key] ?? null) as ReportCellValue);
                return `<td style="text-align:${column.align === 'right' ? 'right' : 'left'}">${escapeHtml(text)}</td>`;
              })
              .join('');
            return `<tr>${tds}</tr>`;
          })
          .join('')
      : `<tr><td colspan="${report.columns.length}">Нет данных</td></tr>`;

  const worksBody =
    lines.length > 0
      ? lines
          .map((line) => {
            const dateStr = formatMoscowDate(line.orderDateMs);
            const qtyStr = formatRuNumber(line.qty, { maximumFractionDigits: 3 });
            const priceStr = formatRuMoney(line.priceRub, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
            const amountStr = formatRuMoney(line.amountRub, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            return `<tr>
  <td>${escapeHtml(dateStr)}</td>
  <td>${escapeHtml(line.workLabel)}</td>
  <td style="text-align:right">${escapeHtml(qtyStr)}</td>
  <td style="text-align:right">${escapeHtml(priceStr)}</td>
  <td style="text-align:right">${escapeHtml(amountStr)}</td>
</tr>`;
          })
          .join('')
      : `<tr><td colspan="5">Нет строк работ по отобранным нарядам</td></tr>`;

  const totalStr = formatRuNumber(totalRub, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const signatures = `
<div class="payroll-sig">
  <div class="payroll-sig-row"><span>Работник</span><span class="payroll-sig-line"></span></div>
  <div class="payroll-sig-row"><span>Проверил (мастер / бригадир)</span><span class="payroll-sig-line"></span></div>
  <div class="payroll-sig-row"><span>Главный бухгалтер</span><span class="payroll-sig-line"></span></div>
  <div class="payroll-sig-row"><span>Руководитель</span><span class="payroll-sig-line"></span></div>
</div>`;

  return `<style>${PAYROLL_PRINT_STYLES}</style>
<div class="payroll-doc">
<div class="payroll-hero">${escapeHtml(hero)}</div>
<div class="payroll-block-title">Данные отчета</div>
<table class="payroll-main"><thead><tr>${headers}</tr></thead><tbody>${mainBody}</tbody></table>
<div class="payroll-block-title">Виды работ по нарядам</div>
<table class="payroll-works">
<thead><tr>
  <th>Дата</th>
  <th>Вид работы</th>
  <th style="text-align:right">Количество</th>
  <th style="text-align:right">Цена</th>
  <th style="text-align:right">Сумма</th>
</tr></thead>
<tbody>${worksBody}</tbody>
</table>
<div class="payroll-total">Итог: ${escapeHtml(totalStr)} ₽</div>
<div class="payroll-formula">Итог совпадает с суммой колонки «Начислено (руб)» по отфильтрованным строкам таблицы выше.</div>
${signatures}
</div>`;
}
