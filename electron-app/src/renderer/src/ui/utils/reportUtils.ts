import type { ReportCellValue, ReportFilterSpec, ReportPresetDefinition, ReportPresetFilters, ReportPresetPreviewResult } from '@matricarmz/shared';

import { formatMoscowDate, formatMoscowDateTime, formatRuMoney, formatRuNumber, formatRuPercent } from './dateUtils.js';
import type { PrintSection } from './printPreview.js';
import { escapeHtml } from './printPreview.js';
import { renderWorkOrderPayrollFormInnerHtml } from './workOrderPayrollReportLayoutHtml.js';

type PreviewOk = Extract<ReportPresetPreviewResult, { ok: true }>;

const REPORT_TOTAL_LABELS: Record<string, string> = {
  employees: 'Сотрудники, шт.',
  workingEmployees: 'Работают, шт.',
  firedEmployees: 'Уволены, шт.',
  firedInPeriod: 'Уволены за период, шт.',
  counterparties: 'Контрагенты, шт.',
  tools: 'Инструменты, шт.',
  inInventory: 'В учете, шт.',
  retired: 'Списано, шт.',
  services: 'Услуги, шт.',
  products: 'Товары, шт.',
  parts: 'Детали, шт.',
  brands: 'Марки, шт.',
  scrapQty: 'Утиль, шт.',
  missingQty: 'Недокомплект, шт.',
  deliveredQty: 'Привезено, шт.',
  remainingNeedQty: 'Остаточная потребность, шт.',
  engines: 'Двигатели, шт.',
  contracts: 'Контракты, шт.',
  totalQty: 'Общий объем, шт.',
  totalAmountRub: 'Сумма, ₽',
  orderedQty: 'Заказано, шт.',
  remainingQty: 'Остаток, шт.',
  fulfillmentPct: '% выполнения',
  progressPct: 'Прогресс, %',
  workOrders: 'Наряды, шт.',
  lines: 'Записей, шт.',
  amountRub: 'Сумма, ₽',
  avgAmountRub: 'Средняя цена, ₽',
  onSiteQty: 'На заводе, шт.',
  acceptance: 'Приёмка',
  shipment: 'Отгрузка',
  customer_delivery: 'Доставка заказчику',
  overdueContracts: 'Просрочено, шт.',
  dueSoonContracts: 'Срок до 30 дней, шт.',
  withIgk: 'С ИГК, шт.',
  withoutIgk: 'Без ИГК, шт.',
  withSeparateAccount: 'С отдельным счетом, шт.',
  withoutSeparateAccount: 'Без отдельного счета, шт.',
  dualPathRows: 'Двойной учёт, шт.',
  nomOnlyRows: 'Только номенклатура, шт.',
  partOnlyRows: 'Только part_card, шт.',
  forecastRows: 'Строк прогноза, шт.',
  plannedEngines: 'Двигателей в плане, шт.',
};

const REPORT_METRIC_NOTES: Record<string, string> = {
  employees: 'Сотрудники: количество работников, попавших в отчетный период.',
  workingEmployees: 'Работают: количество сотрудников со статусом "работает".',
  firedEmployees: 'Уволены: количество сотрудников со статусом "уволен".',
  firedInPeriod: 'Уволены за период: сотрудники с датой увольнения в выбранном диапазоне.',
  counterparties: 'Контрагенты: количество контрагентов в текущей выборке.',
  tools: 'Инструменты: общее количество карточек инструмента в отчете.',
  inInventory: 'В учете: инструменты без даты списания.',
  retired: 'Списано: инструменты с заполненной датой списания.',
  services: 'Услуги: количество услуг, вошедших в прайс-лист.',
  products: 'Товары: количество товарных позиций каталога.',
  parts: 'Детали: количество уникальных деталей в отчете.',
  brands: 'Марки: количество уникальных марок двигателей в отчете.',
  scrapQty: 'Утиль: количество бракованных деталей.',
  missingQty: 'Недокомплект: детали, которых не хватает по плану.',
  deliveredQty: 'Привезено: фактический объём поступивших деталей.',
  remainingNeedQty: 'Остаточная потребность: сколько нужно еще поставить.',
  totalQty: 'Общий объем: общий объем по всем строкам отчета.',
  totalAmountRub: 'Сумма: итоговая стоимость по всем выбранным данным.',
  orderedQty: 'Заказано: плановый объем по договоренностям.',
  remainingQty: 'Остаток: еще не закрытый объем.',
  fulfillmentPct: 'Процент выполнения: доля выполнения по плану.',
  progressPct: 'Прогресс: доля закрытых этапов.',
  overdueContracts: 'Просрочено: количество контрактов, срок которых уже истек.',
  dueSoonContracts: 'Срок до 30 дней: контракты, где дедлайн наступит в ближайший месяц.',
  withIgk: 'С ИГК: количество контрактов с заполненным ИГК.',
  withoutIgk: 'Без ИГК: количество контрактов без ИГК.',
  withSeparateAccount: 'С отдельным счетом: количество контрактов с заполненным полем счета.',
  withoutSeparateAccount: 'Без отдельного счета: количество контрактов без заполненного счета.',
  avgAmountRub: 'Средняя цена: среднее значение цены по строкам отчета.',
};

export function startOfDayMs(value: Date) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDayMs(value: Date) {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function toInputDate(value: unknown) {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (ms == null) return '';
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function fromInputDate(value: string, mode: 'start' | 'end'): number | null {
  if (!value) return null;
  const [yy, mm, dd] = value.split('-').map((x) => Number(x));
  if (!yy || !mm || !dd) return null;
  const date = new Date(yy, mm - 1, dd);
  return mode === 'end' ? endOfDayMs(date) : startOfDayMs(date);
}

export function formatReportCell(
  kind: ReportFilterSpec['type'] | 'date' | 'datetime' | 'number' | 'text',
  value: ReportCellValue,
  columnKey = '',
): string {
  if (value == null) return '';
  if (kind === 'date' && typeof value === 'number') return formatMoscowDate(value);
  if (kind === 'datetime' && typeof value === 'number') return formatMoscowDateTime(value);
  if (kind === 'number' && typeof value === 'number') {
    const key = String(columnKey).toLowerCase();
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

export function csvDownload(csv: string, fileName: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function textDownload(text: string, fileName: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function binaryDownloadBase64(contentBase64: string, fileName: string, mime: string) {
  const bytes = Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function buildDefaultFilters(preset: ReportPresetDefinition): ReportPresetFilters {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const out: ReportPresetFilters = {};
  for (const filter of preset.filters) {
    if (filter.type === 'date_range') {
      out[filter.startKey] = startOfDayMs(monthStart);
      out[filter.endKey] = endOfDayMs(now);
      continue;
    }
    if (filter.type === 'multi_select') {
      out[filter.key] = [];
      continue;
    }
    if (filter.type === 'checkbox') {
      out[filter.key] = filter.key === 'includePurchases';
      continue;
    }
    if (filter.type === 'select') {
      out[filter.key] = filter.options?.[0]?.value ?? '';
      continue;
    }
    if (filter.type === 'number') {
      const fallback = filter.defaultValue ?? 0;
      out[filter.key] = Number.isFinite(fallback) ? fallback : 0;
      continue;
    }
    if (filter.type === 'text') {
      out[filter.key] = filter.defaultValue ?? '';
    }
  }
  return out;
}

function reportTotalLabel(key: string): string {
  return REPORT_TOTAL_LABELS[key] ?? key;
}

function formatReportTotalValue(key: string, value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '');
  const normalizedKey = key.toLowerCase();
  const isPercent = normalizedKey.includes('pct');
  if (isPercent) {
    return formatRuPercent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  const isMoney = normalizedKey.includes('amount') && (normalizedKey.includes('rub') || normalizedKey.includes('₽'));
  if (isMoney) {
    return formatRuMoney(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return formatRuNumber(value, { maximumFractionDigits: 2 });
}

export function formatReportTotals(totals: Record<string, unknown>): string[] {
  return Object.entries(totals).map(([key, value]) => {
    const label = reportTotalLabel(key);
    return `${label}: ${formatReportTotalValue(key, value)}`;
  });
}

export function buildReportMetricNotesHtml(totals: Record<string, unknown>): string[] {
  return Object.keys(totals)
    .map((key) => {
      const note = REPORT_METRIC_NOTES[key];
      if (!note) return null;
      return `<li><strong>${escapeHtml(reportTotalLabel(key))}</strong>: ${escapeHtml(note)}</li>`;
    })
    .filter((line): line is string => line !== null);
}

function assemblyForecastRowIsBold(report: PreviewOk, row: Record<string, ReportCellValue>): boolean {
  if (report.presetId !== 'assembly_forecast_7d') return false;
  return String((row as Record<string, unknown>)['_assemblyStatusCode'] ?? '') === 'ok';
}

function assemblyForecastStatusPrintClass(statusText: string): string {
  if (statusText === 'Хватает') return 'afp-st-ok';
  if (statusText === 'Частично') return 'afp-st-wait';
  if (statusText === 'Не хватает') return 'afp-st-bad';
  return 'afp-st-neu';
}

function renderAssemblyForecastConsumptionPrint(text: string): string {
  const lines = text.split('\n').filter((s) => s.trim().length > 0);
  if (lines.length <= 1) return escapeHtml(text);
  return lines.map((line) => `<div class="afp-cons">${escapeHtml(line)}</div>`).join('');
}

/** Печать / предпросмотр: компактные стили без внешнего CSS. */
export function renderAssemblyForecastTableForPrint(report: PreviewOk): string {
  const style = `<style>
.afp-wrap{font-size:14px;color:#0b1220}
.afp-table{width:100%;border-collapse:collapse;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden}
.afp-th{padding:9px 10px;background:linear-gradient(180deg,#f8fafc,#eef2f7);border-bottom:1px solid #cbd5e1;font-weight:800;font-size:14px;text-align:left}
.afp-td{padding:9px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;line-height:1.45}
.afp-tr-ok{background:#ecfdf5;box-shadow:inset 3px 0 0 0 #16a34a}
.afp-tr-wait{background:#fffbeb;box-shadow:inset 3px 0 0 0 #d97706}
.afp-tr-short{background:#fef2f2;box-shadow:inset 3px 0 0 0 #dc2626}
.afp-st{display:inline-block;padding:2px 9px;border-radius:999px;font-size:14px;font-weight:800;letter-spacing:0.03em;border:1px solid transparent}
.afp-st-ok{background:rgba(22,163,74,0.14);color:#14532d;border-color:rgba(22,163,74,0.35)}
.afp-st-wait{background:rgba(217,119,6,0.16);color:#7c2d12;border-color:rgba(217,119,6,0.4)}
.afp-st-bad{background:rgba(220,38,38,0.12);color:#7f1d1d;border-color:rgba(220,38,38,0.35)}
.afp-st-neu{background:#f8fafc;color:#475569;border-color:#e2e8f0}
.afp-cons{padding:5px 0 5px 8px;margin-bottom:5px;border-left:2px solid rgba(37,99,235,0.35);background:rgba(248,250,252,0.95);border-radius:0 6px 6px 0}
.afp-cons:last-child{margin-bottom:0}
</style>`;

  const head = report.columns
    .map(
      (c) =>
        `<th class="afp-th" style="text-align:${c.align === 'right' ? 'right' : 'left'}">${escapeHtml(c.label)}</th>`,
    )
    .join('');
  const body =
    report.rows.length > 0
      ? report.rows
          .map((row) => {
            const code = String((row as Record<string, unknown>)['_assemblyStatusCode'] ?? '');
            const trClass =
              code === 'ok' ? 'afp-tr-ok' : code === 'waiting' ? 'afp-tr-wait' : code === 'shortage' ? 'afp-tr-short' : '';
            const cells = report.columns
              .map((column) => {
                const value = row[column.key] ?? null;
                const text = formatReportCell(column.kind ?? 'text', value as ReportCellValue, column.key);
                if (column.key === 'status') {
                  const cls = assemblyForecastStatusPrintClass(text);
                  return `<td class="afp-td" style="text-align:${column.align === 'right' ? 'right' : 'left'}"><span class="afp-st ${cls}">${escapeHtml(text)}</span></td>`;
                }
                if (column.key === 'requiredComponentsSummary') {
                  return `<td class="afp-td" style="text-align:left">${renderAssemblyForecastConsumptionPrint(text)}</td>`;
                }
                return `<td class="afp-td" style="text-align:${column.align === 'right' ? 'right' : 'left'}">${escapeHtml(text)}</td>`;
              })
              .join('');
            return `<tr class="${trClass}">${cells}</tr>`;
          })
          .join('')
      : `<tr><td class="afp-td" colspan="${report.columns.length}" style="text-align:center;color:#64748b">Нет данных</td></tr>`;
  return `${style}<div class="afp-wrap"><table class="afp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function renderAssemblyForecastFooterForPrint(lines: string[]): string {
  const style = `<style>
.afp-fn{border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;margin-top:10px}
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
  ];
  const body = lines
    .map((line) => {
      const t = line.trim();
      if (t.startsWith('•')) {
        return `<div class="afp-fn-line afp-fn-bul">${escapeHtml(line)}</div>`;
      }
      if (LEAD.some((p) => t.startsWith(p))) {
        return `<div class="afp-fn-lead">${escapeHtml(line)}</div>`;
      }
      return `<div class="afp-fn-line">${escapeHtml(line)}</div>`;
    })
    .join('');
  return `${style}<div class="afp-fn"><div class="afp-fn-h">Пояснения</div>${body}</div>`;
}

export function renderReportTableHtml(report: PreviewOk) {
  if (report.presetId === 'assembly_forecast_7d') {
    return renderAssemblyForecastTableForPrint(report);
  }
  const head = report.columns
    .map((column) => `<th style="text-align:${column.align === 'right' ? 'right' : 'left'}">${escapeHtml(column.label)}</th>`)
    .join('');
  const body =
    report.rows.length > 0
      ? report.rows
          .map((row) => {
            const bold = assemblyForecastRowIsBold(report, row);
            const cells = report.columns
              .map((column) => {
                const value = row[column.key] ?? null;
                const text = formatReportCell(column.kind ?? 'text', value as ReportCellValue, column.key);
                return `<td style="text-align:${column.align === 'right' ? 'right' : 'left'}">${escapeHtml(text)}</td>`;
              })
              .join('');
            return `<tr style="${bold ? 'font-weight:700' : ''}">${cells}</tr>`;
          })
          .join('')
      : `<tr><td colspan="${report.columns.length}">Нет данных</td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Секции окна предпросмотра печати: для `work_order_payroll` — только печатная форма без сводных блоков. */
export function buildReportPrintPreviewSections(report: PreviewOk): PrintSection[] {
  if (report.presetId === 'work_order_payroll') {
    return [{ id: 'payroll-form', title: 'Печатная форма', html: renderWorkOrderPayrollFormInnerHtml(report) }];
  }
  const sections: PrintSection[] = [
    { id: 'table', title: 'Данные отчета', html: renderReportTableHtml(report) },
    {
      id: 'totals',
      title: 'Итого по отчету',
      html:
        report.totals && Object.keys(report.totals).length > 0
          ? `<ul>${formatReportTotals(report.totals)
              .map((line) => `<li>${escapeHtml(line)}</li>`)
              .join('')}</ul>`
          : '<div class="muted">Нет итогов</div>',
    },
    {
      id: 'groups',
      title: 'Итоги по группам (ключевые метрики)',
      html:
        report.totalsByGroup && report.totalsByGroup.length > 0
          ? `<ul>${report.totalsByGroup
              .map((row) => `<li>${escapeHtml(row.group)}: ${escapeHtml(formatReportTotals(row.totals).join(', '))}</li>`)
              .join('')}</ul>`
          : '<div class="muted">Нет группировок</div>',
    },
    {
      id: 'metric-notes',
      title: 'Пояснение метрик',
      html:
        report.totals && Object.keys(report.totals).length > 0
          ? buildReportMetricNotesHtml(report.totals).length > 0
            ? `<ul>${buildReportMetricNotesHtml(report.totals).join('')}</ul>`
            : '<div class="muted">Нет пояснений</div>'
          : '<div class="muted">Нет данных</div>',
    },
  ];
  if (report.footerNotes && report.footerNotes.length > 0) {
    sections.splice(1, 0, {
      id: 'footer-notes',
      title: 'Пояснения',
      html:
        report.presetId === 'assembly_forecast_7d'
          ? renderAssemblyForecastFooterForPrint(report.footerNotes)
          : `<ul>${report.footerNotes.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
    });
  }
  return sections;
}
