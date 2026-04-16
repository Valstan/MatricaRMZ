import type { ReportCellValue, ReportFilterSpec, ReportPresetDefinition, ReportPresetFilters, ReportPresetPreviewResult } from '@matricarmz/shared';

import { formatMoscowDate, formatMoscowDateTime, formatRuMoney, formatRuNumber, formatRuPercent } from './dateUtils.js';
import { escapeHtml } from './printPreview.js';

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

export function renderReportTableHtml(report: PreviewOk) {
  const head = report.columns
    .map((column) => `<th style="text-align:${column.align === 'right' ? 'right' : 'left'}">${escapeHtml(column.label)}</th>`)
    .join('');
  const body =
    report.rows.length > 0
      ? report.rows
          .map((row) => {
            const cells = report.columns
              .map((column) => {
                const value = row[column.key] ?? null;
                const text = formatReportCell(column.kind ?? 'text', value as ReportCellValue, column.key);
                return `<td style="text-align:${column.align === 'right' ? 'right' : 'left'}">${escapeHtml(text)}</td>`;
              })
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('')
      : `<tr><td colspan="${report.columns.length}">Нет данных</td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
