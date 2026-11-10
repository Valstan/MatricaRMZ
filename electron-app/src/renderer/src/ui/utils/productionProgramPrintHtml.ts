import {
  PRODUCTION_PROGRAM_STATE_LABELS,
  buildProductionProgramPrintModel,
  formatProductionProgramPeriod,
  parseProductionProgramState,
  type ProductionProgramPrintInput,
  type ProductionProgramPrintModel,
} from '@matricarmz/shared';

import { formatMoscowDate } from './dateUtils.js';

/**
 * Печатная форма производственной программы (ПП) — по образцу «ПП Цех № 1».
 *
 * Метрики образца: A4 landscape, поля 12,7 мм, Times New Roman, семь колонок
 * шириной 15,7 / 47,8 / 62,0 / 39,5 / 28,1 / 43,0 / 34,8 мм (в сумме — печатная
 * ширина полосы 271 мм при полях 12,7 мм).
 *
 * Кегль: **не меньше 14 pt** — требование владельца важнее совпадения с образцом
 * (в образце тело 12 pt, но читать форму на цеховом принтере невозможно).
 *
 * Оформление строк — инлайном (классы не читаются при выгрузке в Word).
 */

/** Ширины колонок в мм — из образца. */
const COL_WIDTHS_MM = [15.7, 47.8, 62.0, 39.5, 28.1, 43.0, 34.8] as const;

const HEADERS = [
  '№ п/п',
  'Организация',
  'Марка и номер двигателя',
  'Состояние',
  'Отгрузка',
  'Факторы, влияющие на выполнение плана',
  'Примечание',
] as const;

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Дата плановой отгрузки — в формате образца («15.11.2026»). */
function formatPlanDate(ms: number | null): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  return formatMoscowDate(ms);
}

function stateCell(state: string | null): string {
  // Разбор значения — в домене (там же, где состояние определено): строка из базы
  // может оказаться чем угодно, печатать надо подпись значения, а не саму строку.
  const parsed = parseProductionProgramState(state);
  const label = parsed ? PRODUCTION_PROGRAM_STATE_LABELS[parsed] : '';
  return escapeHtml(label || '—');
}

function rowHtml(model: ProductionProgramPrintModel): string {
  const body: string[] = [];
  for (const group of model.groups) {
    // Шапка группы: организация и номер договора — одна строка на весь план.
    body.push(
      `<tr style="background:#f3f4f6;font-weight:700">` +
        `<td colspan="${HEADERS.length}" style="border:1px solid #111827;padding:4px 6px">${escapeHtml(group.label)}</td>` +
        `</tr>`,
    );
    for (const row of group.rows) {
      // Подсветка — только «готов к отгрузке»: отгруженные строки получают гриф
      // «Отгружен» БЕЗ заливки, иначе весь план «позеленеет» и подсветка перестанет
      // что-то значить (решение владельца).
      const ready = row.highlight === 'ready';
      const bg = ready ? 'background:#dcfce7' : '';
      const shipped = row.highlight === 'shipped';
      const shipping = row.shippingPlanAt
        ? formatPlanDate(row.shippingPlanAt)
        : row.shippingFactAt
          ? formatPlanDate(row.shippingFactAt)
          : '';
      const shippingText = shipped ? `${shipping} (отгружен)` : shipping;
      body.push(
        `<tr style="${bg}">` +
          `<td style="border:1px solid #111827;padding:3px 4px;text-align:center">${row.orderNo}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${escapeHtml(row.organizationLabel)}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${escapeHtml(
            [row.engineMark, row.engineNumber].filter(Boolean).join(' '),
          )}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${stateCell(row.state)}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${escapeHtml(shippingText)}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${escapeHtml(row.factors)}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${escapeHtml(row.note)}</td>` +
          `</tr>`,
      );
    }
  }
  if (body.length === 0) {
    body.push(
      `<tr><td colspan="${HEADERS.length}" style="border:1px solid #111827;padding:6px;text-align:center">Строк в плане нет</td></tr>`,
    );
  }
  return body.join('');
}

/**
 * Сетка подписей: должность и ФИО из документа или из карточки сотрудника.
 *
 * Подписи идут ВЕРТИКАЛЬНО в два столбца (владелец 10.11.2026: «подписи размещай не
 * в горизонтальном виде, а и в вертикальном, то есть подписи должны идти друг под
 * дружкой… может быть, в два столбца»): восемь подписей в одну строку занимали
 * половину листа, а в два столбца занимают четверть.
 */
function signaturesHtml(model: ProductionProgramPrintModel, fontSize: number): string {
  const cells = model.signatures.map(
    (s) =>
      `<td style="border:0;padding:0 12px 10px 0;vertical-align:top;width:50%">` +
      `<div style="font-size:${fontSize}pt">${escapeHtml(s.caption)}</div>` +
      `<div style="font-size:${fontSize}pt;border-bottom:1px solid #111827;margin-top:22px">${escapeHtml(s.name)}</div>` +
      `</td>`,
  );
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    const pair = cells.slice(i, i + 2);
    // Нечётная подпись занимает левую половину — вторая ячейка пустая.
    rows.push(`<tr>${pair.join('')}${pair.length === 1 ? '<td style="border:0"></td>' : ''}</tr>`);
  }
  if (rows.length === 0) return '';
  return `<table style="width:100%;border-collapse:collapse;margin-top:14px">${rows.join('')}</table>`;
}

/** Настройки печати формы ПП: кегли и состав подписей. */
export type ProductionProgramPrintOptions = {
  /** Кегль шапки формы (pt). По умолчанию 14. */
  headerFontSize?: number | undefined;
  /** Кегль таблицы строк (pt). По умолчанию 14. */
  tableFontSize?: number | undefined;
  /** Кегль подписей (pt). По умолчанию 14. */
  signatureFontSize?: number | undefined;
  /**
   * Подписи, которые печатаем (по названию должности). undefined/null — все.
   * Пустой список — ни одной подписи.
   */
  signatureCaptions?: readonly string[] | null | undefined;
};

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

function clampFontSize(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

/** Печатный HTML производственной программы. */
export function productionProgramPrintHtml(
  input: ProductionProgramPrintInput,
  options?: ProductionProgramPrintOptions,
): string {
  const model = buildProductionProgramPrintModel(input);
  const headerSize = clampFontSize(options?.headerFontSize, DEFAULT_FONT_SIZE);
  const tableSize = clampFontSize(options?.tableFontSize, DEFAULT_FONT_SIZE);
  const signatureSize = clampFontSize(options?.signatureFontSize, DEFAULT_FONT_SIZE);
  const wanted = options?.signatureCaptions ?? null;
  const signatures = wanted == null ? model.signatures : model.signatures.filter((s) => wanted.includes(s.caption));
  const colgroup = `<colgroup>${COL_WIDTHS_MM.map((w) => `<col style="width:${w}mm"/>`).join('')}</colgroup>`;
  const header = HEADERS.map(
    (h, i) =>
      `<th style="border:1px solid #111827;padding:4px 5px;font-size:${tableSize}pt;text-align:center;${i === 1 || i === 5 || i === 6 ? 'text-align:left' : ''}">${escapeHtml(h)}</th>`,
  ).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${escapeHtml(model.title)}</title>
<style>
@page { size: A4 landscape; margin: 12.7mm; }
body { margin: 0; font-family: "Times New Roman", Times, serif; font-size: ${tableSize}pt; color: #111827; }
.pp-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.pp-approver { text-align: right; font-size: ${headerSize}pt; }
.pp-title { text-align: center; font-size: ${headerSize + 2}pt; font-weight: 700; margin: 6px 0 2px 0; }
.pp-period { text-align: center; font-size: ${headerSize}pt; margin-bottom: 8px; }
table.pp-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.pp-table th { background: #f3f4f6; }
</style>
</head><body>
<div class="pp-head">
  <div style="font-size:${headerSize}pt">${escapeHtml(model.shop)}</div>
  <div class="pp-approver">
    <div>${escapeHtml(model.approver.title)}</div>
    <div style="margin-top:20px">${escapeHtml(model.approver.position)}</div>
    <div style="border-bottom:1px solid #111827;margin-top:14px">${escapeHtml(model.approver.fullName)}</div>
  </div>
</div>
<div class="pp-title">${escapeHtml(model.title)}</div>
<div class="pp-period">${escapeHtml(model.periodLabel)} · двигателей в плане: ${model.engineCount}</div>
<table class="pp-table">
${colgroup}
<thead><tr>${header}</tr></thead>
<tbody>${rowHtml(model)}</tbody>
</table>
${signaturesHtml({ ...model, signatures }, signatureSize)}
</body></html>`;
}

/** Подпись плана отдельной строкой — для заголовка окна печати. */
export function productionProgramPrintTitle(input: ProductionProgramPrintInput): string {
  const period = formatProductionProgramPeriod(input.period);
  return `${input.title} — ${period}`;
}

/**
 * Печать формы ПП: окно с готовым документом и `print()` из открывающего окна
 * (inline-скрипты в document.write-окне Electron не исполняются — тот же приём,
 * что в `printSectionsDirect`).
 *
 * Это ПРЯМАЯ печать без превью. Оператору нужен промежуточный этап (владелец
 * 10.11.2026: «нужен промежуточный этап, чтобы можно было редактировать форму
 * печати галочками»), поэтому кнопка «Печать» открывает окно превью
 * (`ProductionProgramPrintPreview`), а сюда попадают уже утверждённые настройки.
 */
export function openProductionProgramPrint(
  input: ProductionProgramPrintInput,
  options?: ProductionProgramPrintOptions,
): boolean {
  const html = productionProgramPrintHtml(input, options);
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    w.addEventListener('afterprint', () => w.close());
    w.focus();
    w.print();
  }, 100);
  return true;
}
