/**
 * Чистая логика печатной формы «Отчёт по нарядам» (без UI/БД/electron-зависимостей):
 * суперсет доступных колонок, проекция выбранных колонок, сортировка (в т.ч. по статусу),
 * и красивый HTML-рендер под стиль формы печати наряда. Тестируется и рендерится изолированно.
 */
import type { ReportCellValue, ReportColumn } from './reports.js';
import { WORK_ORDER_STATUS_LABELS, type WorkOrderStatusCode } from './workOrder.js';

export type WorkOrdersReportRow = Record<string, ReportCellValue>;

/** Полный набор доступных колонок (суперсет). Порядок = канонический порядок печати. */
export const WORK_ORDERS_REPORT_COLUMNS: ReportColumn[] = [
  { key: 'orderDate', label: 'Дата выдачи', kind: 'date' },
  { key: 'workOrderNumber', label: '№ наряда' },
  { key: 'kindLabel', label: 'Тип' },
  { key: 'statusLabel', label: 'Статус' },
  { key: 'startDate', label: 'Начало работ', kind: 'date' },
  { key: 'dueDate', label: 'Срок', kind: 'date' },
  { key: 'completedDate', label: 'Дата выполнения', kind: 'date' },
  { key: 'shippedDate', label: 'Отгружен', kind: 'date' },
  { key: 'workType', label: 'Виды работ' },
  { key: 'engineBrand', label: 'Марка дв.' },
  { key: 'engineNumber', label: '№ дв.' },
  { key: 'engineInternalNumber', label: 'Внутр. №' },
  { key: 'counterparty', label: 'Контрагент' },
  { key: 'performers', label: 'Исполнители' },
  { key: 'crewCount', label: 'Бригада, чел.', kind: 'number', align: 'right' },
  { key: 'responsible', label: 'Ответственный' },
  { key: 'amountRub', label: 'Сумма, ₽', kind: 'number', align: 'right' },
];

/** Опции для multi_select-фильтра выбора колонок. */
export const WORK_ORDERS_REPORT_COLUMN_OPTIONS = WORK_ORDERS_REPORT_COLUMNS.map((c) => ({ value: c.key, label: c.label }));

/** Какие колонки печатать (в каноническом порядке). Пусто → все (отчёт без колонок не имеет смысла). */
export function selectWorkOrdersReportColumns(selectedKeys: ReadonlyArray<string>): ReportColumn[] {
  const set = new Set(selectedKeys.map((k) => String(k).trim()).filter(Boolean));
  if (set.size === 0) return [...WORK_ORDERS_REPORT_COLUMNS];
  return WORK_ORDERS_REPORT_COLUMNS.filter((c) => set.has(c.key));
}

export type WorkOrdersReportSortBy =
  | 'orderDate'
  | 'status'
  | 'workOrderNumber'
  | 'dueDate'
  | 'completedDate'
  | 'shippedDate'
  | 'engineBrand'
  | 'amountRub';

/** Порядок сортировки по статусу — по срочности: сначала просроченные, затем открытые, потом выполненные. */
const STATUS_SORT_ORDER: Record<WorkOrderStatusCode, number> = { overdue: 0, issued: 1, withdrawn: 2, done_late: 3, done: 4 };

function asNum(v: ReportCellValue | undefined): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}
function asStr(v: ReportCellValue | undefined): string {
  return v == null ? '' : String(v);
}

export function sortWorkOrdersReportRows(
  rows: ReadonlyArray<WorkOrdersReportRow>,
  sortBy: WorkOrdersReportSortBy,
  sortDir: 'asc' | 'desc',
): WorkOrdersReportRow[] {
  const dir = sortDir === 'asc' ? 1 : -1;
  const primary = (a: WorkOrdersReportRow, b: WorkOrdersReportRow): number => {
    switch (sortBy) {
      case 'status':
        return (
          (STATUS_SORT_ORDER[String(a.statusCode) as WorkOrderStatusCode] ?? 99) -
          (STATUS_SORT_ORDER[String(b.statusCode) as WorkOrderStatusCode] ?? 99)
        );
      case 'workOrderNumber':
        return asNum(a.workOrderNumber) - asNum(b.workOrderNumber);
      case 'dueDate':
        return asNum(a.dueDate) - asNum(b.dueDate);
      case 'completedDate':
        return asNum(a.completedDate) - asNum(b.completedDate);
      case 'shippedDate':
        return asNum(a.shippedDate) - asNum(b.shippedDate);
      case 'engineBrand':
        return asStr(a.engineBrand).localeCompare(asStr(b.engineBrand), 'ru');
      case 'amountRub':
        return asNum(a.amountRub) - asNum(b.amountRub);
      case 'orderDate':
      default:
        return asNum(a.orderDate) - asNum(b.orderDate);
    }
  };
  // Вторичный детерминированный порядок: свежие по дате выдачи, затем по № наряда.
  return [...rows].sort((a, b) => {
    const p = primary(a, b) * dir;
    if (p !== 0) return p;
    const byDate = asNum(b.orderDate) - asNum(a.orderDate);
    if (byDate !== 0) return byDate;
    return asNum(a.workOrderNumber) - asNum(b.workOrderNumber);
  });
}

// ── Сводка по статусам (подвал отчёта) ─────────────────────────────────────

/** Счётчики нарядов для подвала отчёта. shipped/accepted — по статусу ДВИГАТЕЛЯ наряда. */
export type WorkOrdersStatusCounts = {
  /** Всего выписано (строк в отчёте). */
  total: number;
  done: number;
  doneLate: number;
  overdue: number;
  withdrawn: number;
  /** Двигатель отправлен заказчику. */
  shipped: number;
  /** Двигатель принят заказчиком. */
  accepted: number;
};

export type WorkOrdersStatusSummary = {
  counts: WorkOrdersStatusCounts;
  /** Опциональная разбивка по маркам двигателей (фильтр summaryByBrand). Порядок — по алфавиту. */
  byBrand?: Array<{ brand: string; counts: WorkOrdersStatusCounts }>;
};

function emptyStatusCounts(): WorkOrdersStatusCounts {
  return { total: 0, done: 0, doneLate: 0, overdue: 0, withdrawn: 0, shipped: 0, accepted: 0 };
}

function accumulateStatusCounts(acc: WorkOrdersStatusCounts, row: WorkOrdersReportRow): void {
  acc.total += 1;
  const code = String(row.statusCode ?? '');
  if (code === 'done') acc.done += 1;
  else if (code === 'done_late') acc.doneLate += 1;
  else if (code === 'overdue') acc.overdue += 1;
  else if (code === 'withdrawn') acc.withdrawn += 1;
  if (row.customerSent === true) acc.shipped += 1;
  if (row.customerAccepted === true) acc.accepted += 1;
}

/**
 * Сводка по строкам отчёта «Наряды» — считается ОДИН раз в main-процессе,
 * все рендеры (on-screen / предпросмотр / печать) переиспользуют результат.
 * Опирается на служебные поля строки: statusCode, customerSent, customerAccepted, engineBrand.
 */
export function computeWorkOrdersStatusSummary(
  rows: ReadonlyArray<WorkOrdersReportRow>,
  opts: { byBrand?: boolean } = {},
): WorkOrdersStatusSummary {
  const counts = emptyStatusCounts();
  const brandMap = new Map<string, WorkOrdersStatusCounts>();
  for (const row of rows) {
    accumulateStatusCounts(counts, row);
    if (opts.byBrand) {
      const brand = String(row.engineBrand ?? '').trim() || '(марка не указана)';
      let acc = brandMap.get(brand);
      if (!acc) {
        acc = emptyStatusCounts();
        brandMap.set(brand, acc);
      }
      accumulateStatusCounts(acc, row);
    }
  }
  const byBrand = opts.byBrand
    ? [...brandMap.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru')).map(([brand, c]) => ({ brand, counts: c }))
    : undefined;
  return { counts, ...(byBrand ? { byBrand } : {}) };
}

export const WORK_ORDERS_STATUS_COUNT_LABELS: ReadonlyArray<{ key: keyof WorkOrdersStatusCounts; label: string }> = [
  { key: 'total', label: 'Выписано' },
  { key: 'done', label: 'Выполнено' },
  { key: 'doneLate', label: 'Выполнено с просрочкой' },
  { key: 'overdue', label: 'Просрочено' },
  { key: 'withdrawn', label: 'Отозвано' },
  { key: 'shipped', label: 'Отгружено заказчику' },
  { key: 'accepted', label: 'Принято заказчиком' },
];

/** Одна строка сводки для текстовых мест (on-screen totals, подпись). */
export function formatWorkOrdersStatusCountsLine(counts: WorkOrdersStatusCounts): string {
  return WORK_ORDERS_STATUS_COUNT_LABELS.map(({ key, label }) => `${label}: ${counts[key]}`).join(' · ');
}

// ── HTML-рендер ─────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function fmtMoscowDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(ms));
}

function fmtRub(v: number): string {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtCell(col: ReportColumn, value: ReportCellValue): string {
  if (value == null || value === '') return '—';
  if (col.kind === 'date') return fmtMoscowDate(Number(value)) || '—';
  if (col.kind === 'number') return col.key === 'amountRub' ? fmtRub(Number(value)) : String(value);
  return String(value);
}

/** Цвет ячейки статуса при печати (палитра как в списке нарядов). */
const STATUS_CELL_STYLE: Record<WorkOrderStatusCode, string> = {
  issued: 'background:#fef3c7;color:#92400e',
  done: 'background:#dcfce7;color:#166534',
  overdue: 'background:#fee2e2;color:#b91c1c',
  done_late: 'background:#fde68a;color:#92400e',
  withdrawn: 'background:#e5e7eb;color:#374151',
};

/** CSS печатной формы отчёта — тёмные рамки/шапка как в форме наряда, A4-landscape. */
const WORK_ORDERS_REPORT_CSS = `
  @page { size: A4 landscape; margin: 12mm; }
  #wo-report-root * { box-sizing: border-box; }
  #wo-report-root { font-family: system-ui, Arial, sans-serif; color: #0f172a; }
  #wo-report-root h1 { text-align: center; font-size: 18px; margin: 0 0 6px 0; }
  #wo-report-root .chips { text-align: center; margin: 0 0 12px 0; line-height: 1.7; }
  #wo-report-root .chip { display: inline-block; margin: 2px 3px; padding: 2px 9px; border: 1px solid #cbd5e1; border-radius: 999px; background: #f8fafc; font-size: 11px; color: #475569; }
  #wo-report-root table { width: 100%; border-collapse: collapse; }
  #wo-report-root th, #wo-report-root td { border: 1px solid #0f172a; padding: 4px 8px; font-size: 12px; text-align: left; vertical-align: top; word-break: break-word; }
  #wo-report-root th { background: #f3f4f6; font-weight: 600; }
  #wo-report-root tbody tr:nth-child(even) td { background: #fafafa; }
  #wo-report-root td.status-cell { font-weight: 600; white-space: nowrap; }
  #wo-report-root td.empty { text-align: center; color: #6b7280; padding: 16px; font-weight: 600; }
  #wo-report-root .totals { margin-top: 12px; padding: 8px 12px; border: 1px solid #0f172a; border-radius: 6px; background: #f8fafc; font-weight: 700; font-size: 13px; }
`;

export type WorkOrdersReportRenderArgs = {
  title: string;
  subtitleChips?: ReadonlyArray<string>;
  columns: ReadonlyArray<ReportColumn>;
  rows: ReadonlyArray<WorkOrdersReportRow>;
  totalsLine?: string;
  /** Сводка по статусам для подвала (+опциональная разбивка по маркам). */
  statusSummary?: WorkOrdersStatusSummary;
};

function renderStatusSummaryHtml(summary: WorkOrdersStatusSummary): string {
  const countsLine = `<div class="totals">${esc(formatWorkOrdersStatusCountsLine(summary.counts))}</div>`;
  if (!summary.byBrand || summary.byBrand.length === 0) return countsLine;
  const head = WORK_ORDERS_STATUS_COUNT_LABELS.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = summary.byBrand
    .map(
      (b) =>
        `<tr><td>${esc(b.brand)}</td>${WORK_ORDERS_STATUS_COUNT_LABELS.map((c) => `<td style="text-align:right">${b.counts[c.key]}</td>`).join('')}</tr>`,
    )
    .join('');
  return `${countsLine}
<div style="margin-top:8px;font-weight:700;font-size:13px">Сводка по маркам двигателей</div>
<table style="margin-top:4px"><thead><tr><th>Марка</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Внутренний фрагмент (со своим <style>) — для окна предпросмотра, где секции вставляются в общий документ. */
export function renderWorkOrdersReportInner(args: WorkOrdersReportRenderArgs): string {
  const columns = args.columns;
  const chips = (args.subtitleChips ?? []).filter(Boolean);
  const chipsHtml = chips.length
    ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>`
    : '';
  const thead = columns
    .map((c) => `<th style="text-align:${c.align === 'right' ? 'right' : 'left'}">${esc(c.label)}</th>`)
    .join('');
  const tbody = args.rows.length
    ? args.rows
        .map((row) => {
          const tds = columns
            .map((c) => {
              const text = fmtCell(c, (row[c.key] ?? null) as ReportCellValue);
              if (c.key === 'statusLabel') {
                const style = STATUS_CELL_STYLE[String(row.statusCode) as WorkOrderStatusCode] ?? '';
                return `<td class="status-cell" style="${style}">${esc(text)}</td>`;
              }
              return `<td style="text-align:${c.align === 'right' ? 'right' : 'left'}">${esc(text)}</td>`;
            })
            .join('');
          return `<tr>${tds}</tr>`;
        })
        .join('')
    : `<tr><td colspan="${Math.max(1, columns.length)}" class="empty">Нет нарядов по заданным фильтрам</td></tr>`;
  const totalsHtml = args.totalsLine ? `<div class="totals">${esc(args.totalsLine)}</div>` : '';
  const summaryHtml = args.statusSummary ? renderStatusSummaryHtml(args.statusSummary) : '';
  return `<style>${WORK_ORDERS_REPORT_CSS}</style>
<div id="wo-report-root">
<h1>${esc(args.title)}</h1>
${chipsHtml}
<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
${totalsHtml}
${summaryHtml}
</div>`;
}

/** Полный самодостаточный HTML-документ под печать/PDF (стиль формы печати наряда). */
export function renderWorkOrdersReportHtml(args: WorkOrdersReportRenderArgs): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/></head><body style="margin:0;padding:16px">${renderWorkOrdersReportInner(args)}</body></html>`;
}

/** Человеческая метка статуса (реэкспорт для удобства билдера). */
export function workOrderStatusLabel(code: WorkOrderStatusCode): string {
  return WORK_ORDER_STATUS_LABELS[code];
}
