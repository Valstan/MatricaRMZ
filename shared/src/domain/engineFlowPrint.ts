import {
  ENGINE_FLOW_DEFAULT_PRINT_LAYOUT,
  ENGINE_FLOW_REQUIRED_COLUMN_KEYS,
  type ReportColumn,
} from './reports.js';
import {
  isPrintSectionEnabled,
  reportColumnFontPx,
  resolveReportPrintLayout,
  type ReportPrintLayout,
} from './reportPrintLayout.js';

/** Метрики отчёта в каноническом порядке печати. */
export const ENGINE_FLOW_METRIC_KEYS = [
  'arrivedQty',
  'shippedQty',
  'scrapTotalQty',
  'scrapAtFactoryQty',
  'scrapSentQty',
  'atFactoryQty',
  'inRepairQty',
] as const;

export type EngineFlowMetricKey = (typeof ENGINE_FLOW_METRIC_KEYS)[number];

/** Заголовки метрик в бумаге — короче колоночных, с переносом строки. */
const METRIC_PRINT_HEADERS: Record<EngineFlowMetricKey, string> = {
  arrivedQty: 'Пришло',
  shippedQty: 'Отгружено<br/>заказчику',
  scrapTotalQty: 'Утиль<br/>всего',
  scrapAtFactoryQty: 'Утиль<br/>на заводе',
  scrapSentQty: 'Утиль<br/>отправлен',
  atFactoryQty: 'На заводе<br/>всего',
  inRepairQty: 'из них<br/>в ремонте',
};

/** Ключи необязательных блоков печатной формы (см. `ReportPrintLayout.sections`). */
export const ENGINE_FLOW_PRINT_SECTIONS = {
  brandSummary: 'brandSummary',
  contractSubtotals: 'contractSubtotals',
} as const;

export type EngineFlowPrintReport = {
  title: string;
  subtitle?: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  footerNotes?: string[];
  printLayout?: ReportPrintLayout;
};

function htmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type Group<T> = { key: string; rows: T[] };

function groupBy<T>(items: T[], keyOf: (item: T) => string): Group<T>[] {
  const out: Group<T>[] = [];
  const index = new Map<string, Group<T>>();
  for (const item of items) {
    const key = keyOf(item);
    let group = index.get(key);
    if (!group) {
      group = { key, rows: [] };
      index.set(key, group);
      out.push(group);
    }
    group.rows.push(item);
  }
  return out;
}

type Row = Record<string, unknown>;

function metricsOf(row: Row, keys: readonly EngineFlowMetricKey[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = Number(row[key] ?? 0) || 0;
  return out;
}

function sumMetrics(list: Array<Record<string, number>>, keys: readonly EngineFlowMetricKey[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = list.reduce((acc, m) => acc + (m[key] ?? 0), 0);
  return out;
}

/** Нули в бумажной таблице глушим прочерком — иначе колонки утиля рябят от «0» и мешают читать. */
function metricCells(metrics: Record<string, number>, keys: readonly EngineFlowMetricKey[]): string {
  return keys
    .map((key) => {
      const value = metrics[key] ?? 0;
      return `<td class="num col-${key}">${value === 0 && key !== 'arrivedQty' ? '—' : String(value)}</td>`;
    })
    .join('');
}

/**
 * Печатная форма А4 «Движение двигателей по заказчикам»: блок на год прихода, внутри —
 * блоки заказчиков со строками договоров (метка объединена по вертикали) и марок,
 * с подытогами договора, заказчика, сводом по маркам, итогом года и общим итогом.
 *
 * Плоские `rows` билдера группируются здесь по служебным ключам `_yearKey`/`_counterpartyKey`/
 * `_contractKey` — подписи для группировки не годятся, два заказчика могут называться одинаково.
 *
 * Что печатать и каким кеглем, решает `report.printLayout` (блок «Печать: колонки и шрифты»
 * в фильтрах): исключённые колонки билдер уже вырезал из `report.columns`, поэтому набор
 * метрик здесь читается из колонок, а не из константы.
 */
export function renderEngineFlowPrintInnerHtml(report: EngineFlowPrintReport): string {
  const layout = resolveReportPrintLayout(report.printLayout ?? {}, ENGINE_FLOW_DEFAULT_PRINT_LAYOUT, {
    requiredKeys: ENGINE_FLOW_REQUIRED_COLUMN_KEYS,
  });
  const visibleKeys = new Set(report.columns.map((c) => c.key));
  const metricKeys = ENGINE_FLOW_METRIC_KEYS.filter((key) => visibleKeys.has(key));
  const showFullNumber = visibleKeys.has('contractFullLabel');
  const showBrandSummary = isPrintSectionEnabled(layout, ENGINE_FLOW_PRINT_SECTIONS.brandSummary);
  const showContractSubtotals = isPrintSectionEnabled(layout, ENGINE_FLOW_PRINT_SECTIONS.contractSubtotals);

  const rows = report.rows as Row[];
  // Ширина под «Договор + Марка»: на А4 с семью метриками более широкий левый блок
  // не оставляет колонке места под слово «Отправлено», и шапка рвёт слова посередине.
  const labelWidthPct = 30;
  const metricWidthPct = metricKeys.length > 0 ? (100 - labelWidthPct) / metricKeys.length : 0;

  // Правило пишем, только если оператор задал кегль колонки явно: иначе базовое
  // `.ef th,.ef td` (специфичность выше одиночного класса) всё равно победит, а заголовки
  // блоков потеряли бы свой увеличенный размер. Селектор из двух частей — ячейка таблицы
  // и вложенные блоки колонки (короткий/полный номер договора, шапки года и заказчика).
  const columnFontCss = report.columns
    .filter((column) => layout.fontPx[column.key] != null)
    .map((column) => `.ef td.col-${column.key},.ef .col-${column.key}{font-size:${reportColumnFontPx(layout, column.key)}px}`)
    .join('\n');

  const style = `<style>
.ef{font-family:Arial,Helvetica,sans-serif;font-size:${layout.basePx}px;color:#0b1220}
.ef h1{font-size:${Math.round(layout.basePx * 1.25)}px;margin:0 0 4px 0}
.ef .meta{color:#475569;font-size:${Math.max(9, layout.basePx - 3)}px;margin-bottom:10px}
.ef .yr{margin-bottom:16px}
.ef .yr-head{font-size:${Math.round(layout.basePx * 1.2)}px;font-weight:800;padding:6px 8px;background:#dbe3ec;border:1px solid #94a3b8;break-after:avoid}
.ef .cp{margin:8px 0 11px 0}
.ef .cp-head{font-size:${Math.round(layout.basePx * 1.05)}px;font-weight:800;padding:5px 7px;background:#eef2f7;border:1px solid #cbd5e1;border-bottom:none;break-after:avoid}
.ef table{border-collapse:collapse;width:100%;table-layout:fixed}
.ef thead{display:table-header-group}
.ef tr{break-inside:avoid}
.ef th,.ef td{border:1px solid #cbd5e1;padding:3px 5px;vertical-align:middle;overflow-wrap:anywhere;font-size:${layout.basePx}px}
.ef th{background:#f8fafc;font-size:${layout.headerPx}px;font-weight:700;line-height:1.2;text-align:center;overflow-wrap:break-word;hyphens:none}
.ef th.col-contractShortLabel,.ef th.col-engineBrand{text-align:left}
.ef .w-contract{width:${(labelWidthPct * 0.45).toFixed(2)}%}
.ef .w-brand{width:${(labelWidthPct * 0.55).toFixed(2)}%}
.ef .w-metric{width:${metricWidthPct.toFixed(2)}%}
.ef td.num,.ef th.num{text-align:right}
.ef th.num{text-align:center}
.ef .c-contract{vertical-align:top}
.ef .c-short{font-weight:700}
.ef .c-full{color:#64748b;margin-top:1px}
.ef tr.sub td{background:#f8fafc;font-weight:700}
.ef tr.cp-sum td{background:#e2e8f0;font-weight:800}
.ef tr.yr-sum td{background:#cbd5e1;font-weight:800}
.ef .sum-table{margin-top:6px}
.ef .sum-head{font-weight:700;padding:4px 7px;background:#f1f5f9;border:1px solid #cbd5e1;border-bottom:none;break-after:avoid}
.ef .grand{margin-top:14px}
.ef .empty{padding:14px;text-align:center;color:#64748b;border:1px dashed #cbd5e1}
.ef .notes{margin-top:12px;border:1px solid #cbd5e1;break-inside:avoid}
.ef .notes-h{padding:4px 7px;font-weight:800;font-size:${Math.max(9, layout.basePx - 3)}px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;background:#f1f5f9;border-bottom:1px solid #e2e8f0}
.ef .notes-line{padding:4px 7px;font-size:${Math.max(9, layout.basePx - 2)}px;color:#475569;border-bottom:1px solid #f1f5f9}
.ef .notes-line:last-child{border-bottom:none}
${columnFontCss}
</style>`;

  const headRow = `<tr>
<th class="col-contractShortLabel w-contract">Договор</th>
<th class="col-engineBrand w-brand">Марка</th>
${metricKeys.map((key) => `<th class="num col-${key} w-metric">${METRIC_PRINT_HEADERS[key]}</th>`).join('\n')}
</tr>`;

  // В своде левая ячейка — марка, а не пара «договор + марка», поэтому у него своя шапка:
  // общая печатала бы над колонкой марок заголовок «Договор».
  const summaryHeadRow = `<tr>
<th class="col-engineBrand w-contract" colspan="2">Марка</th>
${metricKeys.map((key) => `<th class="num col-${key} w-metric">${METRIC_PRINT_HEADERS[key]}</th>`).join('\n')}
</tr>`;

  /** Свод по маркам: строка на марку с суммой по всем её строкам блока. */
  function brandSummaryTable(scopeRows: Row[], title: string): string {
    if (!showBrandSummary || scopeRows.length === 0) return '';
    const brands = groupBy(scopeRows, (row) => String(row.engineBrand ?? ''));
    if (brands.length === 0) return '';
    const body = brands
      .map((brand) => {
        const metrics = sumMetrics(
          brand.rows.map((row) => metricsOf(row, metricKeys)),
          metricKeys,
        );
        return `<tr><td class="col-engineBrand" colspan="2">${htmlEscape(brand.key)}</td>${metricCells(metrics, metricKeys)}</tr>`;
      })
      .join('');
    return `<div class="sum-table"><div class="sum-head">${htmlEscape(title)}</div><table><thead>${summaryHeadRow}</thead><tbody>${body}</tbody></table></div>`;
  }

  function counterpartySection(counterpartyRows: Row[]): string {
    const contractGroups = groupBy(counterpartyRows, (row) => String(row._contractKey ?? row.contractShortLabel ?? ''));
    const body = contractGroups
      .map((contract) => {
        const brandMetrics = contract.rows.map((row) => metricsOf(row, metricKeys));
        const withSubtotal = showContractSubtotals && contract.rows.length > 1;
        const span = contract.rows.length + (withSubtotal ? 1 : 0);
        const first = contract.rows[0] ?? {};
        const shortLabel = String(first.contractShortLabel ?? '');
        const fullLabel = String(first.contractFullLabel ?? '');
        const contractCell = `<td class="c-contract w-contract" rowspan="${span}"><div class="c-short col-contractShortLabel">${htmlEscape(
          shortLabel,
        )}</div>${
          showFullNumber && fullLabel ? `<div class="c-full col-contractFullLabel">${htmlEscape(fullLabel)}</div>` : ''
        }</td>`;
        const brandRows = contract.rows
          .map((row, index) => {
            const metrics = brandMetrics[index] ?? metricsOf(row, metricKeys);
            const lead = index === 0 ? contractCell : '';
            return `<tr>${lead}<td class="col-engineBrand w-brand">${htmlEscape(String(row.engineBrand ?? ''))}</td>${metricCells(
              metrics,
              metricKeys,
            )}</tr>`;
          })
          .join('');
        const subtotal = withSubtotal
          ? `<tr class="sub"><td class="col-engineBrand w-brand">Итого по договору</td>${metricCells(
              sumMetrics(brandMetrics, metricKeys),
              metricKeys,
            )}</tr>`
          : '';
        return `${brandRows}${subtotal}`;
      })
      .join('');
    const counterpartyTotal = sumMetrics(
      counterpartyRows.map((row) => metricsOf(row, metricKeys)),
      metricKeys,
    );
    const totalRow = `<tr class="cp-sum"><td colspan="2">Итого по заказчику</td>${metricCells(counterpartyTotal, metricKeys)}</tr>`;
    const name = String(counterpartyRows[0]?.counterpartyLabel ?? '');
    return `<section class="cp">
<div class="cp-head col-counterpartyLabel">${htmlEscape(name)}</div>
<table><thead>${headRow}</thead><tbody>${body}${totalRow}</tbody></table>
</section>`;
  }

  const yearGroups = groupBy(rows, (row) => String(row._yearKey ?? row.yearLabel ?? ''));
  const yearSections = yearGroups
    .map((year) => {
      const counterpartyGroups = groupBy(year.rows, (row) => String(row._counterpartyKey ?? row.counterpartyLabel ?? ''));
      const blocks = counterpartyGroups.map((counterparty) => counterpartySection(counterparty.rows)).join('');
      const yearLabel = String(year.rows[0]?.yearLabel ?? year.key);
      const yearTotal = sumMetrics(
        year.rows.map((row) => metricsOf(row, metricKeys)),
        metricKeys,
      );
      const summary = brandSummaryTable(year.rows, `Свод по маркам · ${yearLabel}`);
      const totalTable = `<div class="sum-table"><table><tbody><tr class="yr-sum"><td class="w-contract" colspan="2">Итого за ${htmlEscape(
        yearLabel,
      )}</td>${metricCells(yearTotal, metricKeys)}</tr></tbody></table></div>`;
      return `<section class="yr">
<div class="yr-head col-yearLabel">${htmlEscape(yearLabel)}</div>
${blocks}
${summary}
${totalTable}
</section>`;
    })
    .join('');

  const grandTotal = sumMetrics(
    rows.map((row) => metricsOf(row, metricKeys)),
    metricKeys,
  );
  const grandBlock =
    rows.length > 0
      ? `<section class="grand"><table><thead>${headRow}</thead><tbody><tr class="cp-sum"><td colspan="2">Итого по всем годам</td>${metricCells(
          grandTotal,
          metricKeys,
        )}</tr></tbody></table>${yearGroups.length > 1 ? brandSummaryTable(rows, 'Свод по маркам · все годы') : ''}</section>`
      : '<div class="empty">Нет данных</div>';

  const notes =
    report.footerNotes && report.footerNotes.length > 0
      ? `<div class="notes"><div class="notes-h">Пояснения</div>${report.footerNotes
          .map((line) => `<div class="notes-line">${htmlEscape(line)}</div>`)
          .join('')}</div>`
      : '';

  return `${style}<div class="ef">
<h1>${htmlEscape(report.title)}</h1>
<div class="meta">${htmlEscape(report.subtitle ?? '')}</div>
${yearSections}
${grandBlock}
${notes}
</div>`;
}

/** Полный HTML-документ печатной формы (окно печати / PDF). */
export function renderEngineFlowPrintHtml(report: EngineFlowPrintReport): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
@page{size:A4 portrait;margin:12mm}
body{margin:0}
</style>
</head><body>
${renderEngineFlowPrintInnerHtml(report)}
</body></html>`;
}
