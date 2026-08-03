// Печатная форма табеля (Т-13): чистые билдеры HTML-секций. Вынесены из TimesheetGridPage,
// чтобы вёрстку бумаги можно было проверять тестом/скриншотом ровно тем же кодом, который печатает.
//
// Правила бумаги (постановка владельца 03.08.2026):
//  · ФИО — только фамилия и инициалы («Асхатов Р.З.»), должность не печатается: всё это съедает
//    ширину, которая нужна клеткам под запись ручкой (в окне табеля показ остаётся полным);
//  · клетки дней — максимально крупные: служебные колонки сжаты по содержимому, высота строки
//    берёт весь остаток листа (`timesheetPrintRowHeightPx`);
//  · выходные — заметно более тёмная заливка: светло-серый экрана на принтере не пропечатывался.
import {
  computeTimesheetRowTotals,
  formatEmployeeSurnameInitials,
  formatTimesheetHours,
  isTimesheetWeekend,
  timesheetCellFontPx,
  TIMESHEET_PRINT_PAGE_PX,
  timesheetDayOfWeek,
  timesheetPrintRowHeightPx,
  type TimesheetCodeDef,
  type TimesheetPrintFonts,
  type TimesheetPrintInk,
} from '@matricarmz/shared';

import { escapeHtml, type PrintSection } from './printPreview.js';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export type TimesheetPrintVariant = 'full' | 'first' | 'second';
/** Какие блоки выводить на печать (все отключаемые галочками в диалоге). */
export type TimesheetPrintBlocks = { header: boolean; grid: boolean; legend: boolean; decode: boolean };

export type TimesheetPrintCell = { code: string | null; hours: number | null; comment: string | null };
/**
 * Строка табеля как её видит печать. `position` сюда приходит (он есть в строке табеля), но
 * НА БУМАГУ НЕ ВЫВОДИТСЯ — специально: должность съедает ширину, нужную клеткам под ручку.
 * Тест печатной формы это стережёт (`не печатает должность`).
 */
export type TimesheetPrintRow = { id: string; fullName: string; position?: string | null };

export type TimesheetPrintInput = {
  year: number;
  month: number;
  weekMode: 5 | 6;
  /** Дней в месяце. */
  days: number;
  /** Дни, попадающие в печать (в порядке вывода колонок). */
  dayList: number[];
  rows: TimesheetPrintRow[];
  codes: TimesheetCodeDef[];
  getCell: (rowId: string, day: number) => TimesheetPrintCell;
  workshopName?: string | null;
};

/**
 * Компактная вёрстка листа: узкие поля, гарантированная печать заливок.
 * Толщина линий сетки — из настроек: на части принтеров линия в 1px не пропечатывается.
 */
export function timesheetPrintCss(ink: TimesheetPrintInk): string {
  return `
    @page { size: A4 landscape; margin: 8mm; }
    @media print { body { margin: 0; } }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    th, td { padding: 1px 2px; line-height: 1.05; vertical-align: middle; border: ${ink.lineWidth}px solid #111827; }
    .section { margin-bottom: 6px; }
  `;
}

/** Шапка листа одной строкой: «Табель учёта рабочего времени за Июль 2026 · Цех №2». */
export function timesheetPrintTitle(input: Pick<TimesheetPrintInput, 'workshopName' | 'month' | 'year'>): string {
  return `Табель учёта рабочего времени за ${MONTHS[input.month - 1]} ${input.year}${input.workshopName ? ` · ${input.workshopName}` : ''}`;
}

// Шапка листа — печатаемая секция (h1 окна печати — .no-print и на бумагу не попадает).
// Одна строка одним кеглем: две строки разного размера съедали высоту, нужную клеткам.
function headerHtml(input: TimesheetPrintInput, f: TimesheetPrintFonts): string {
  return `<div style="font-size:${f.header}px;font-weight:700;line-height:1.15">${escapeHtml(timesheetPrintTitle(input))}</div>`;
}

/**
 * Содержимое ячейки на бумаге — ОДНО значение одним кеглем, подогнанным под ширину клетки.
 *
 * Буква важнее часов: «К8» мелкой буквой и крупной восьмёркой читалось как обычная явка, и
 * командировку путали с работой. Поэтому если у дня стоит код (кроме «Я» — это и есть явка),
 * печатается ТОЛЬКО код во весь размер клетки; часы остаются в учёте и в итогах строки.
 * Двухбуквенные коды и «9,5» уменьшаются ровно настолько, чтобы не расширить колонку.
 */
function cellHtml(c: TimesheetPrintCell, f: TimesheetPrintFonts, color: string, cellWidthPx: number): string {
  const code = c.code === 'Я' ? '' : (c.code ?? '');
  const text = code || formatTimesheetHours(c.hours);
  if (!text) return '';
  return `<div style="font-size:${timesheetCellFontPx(text, f.cell, cellWidthPx)}px;font-weight:800;color:${color};line-height:1.05">${escapeHtml(text)}</div>`;
}

function gridHtml(input: TimesheetPrintInput, fromDay: number, toDay: number, f: TimesheetPrintFonts, rowHeightPx: number, ink: TimesheetPrintInk): string {
  const cols = input.dayList.filter((d) => d >= fromDay && d <= toDay);
  // Служебные колонки (№, ФИО, Σч, дн.) сжимаются по содержимому (width:1% + nowrap),
  // всю остальную ширину листа поровну забирают дни — под запись ручкой.
  const dayWidth = `${Math.max(1, Math.floor(92 / Math.max(1, cols.length)))}%`;
  // Полезная ширина клетки дня: доля листа минус паддинги и рамки — по ней мельчим длинные значения.
  const dayCellWidthPx = Math.max(6, (TIMESHEET_PRINT_PAGE_PX.width * 0.92) / Math.max(1, cols.length) - 4 - 2 * ink.lineWidth);
  const weekend = (d: number) => isTimesheetWeekend(input.year, input.month, d, input.weekMode);
  const headWeekend = ink.level > 0 ? `;background:${ink.weekendHeadBg};color:${ink.weekendText}` : '';
  const bodyWeekend = ink.level > 0 ? `;background:${ink.weekendBg}` : '';
  const head =
    `<tr><th style="font-size:${f.dayNum}px;width:1%;white-space:nowrap">№</th>` +
    `<th style="text-align:left;font-size:${f.dayNum}px;width:1%;white-space:nowrap">ФИО</th>` +
    cols
      .map(
        (d) =>
          `<th style="font-size:${f.dayNum}px;line-height:1.05;width:${dayWidth}${weekend(d) ? headWeekend : ''}">${d}<br/><span style="font-weight:400;font-size:${f.weekday}px">${DOW[timesheetDayOfWeek(input.year, input.month, d)]}</span></th>`,
      )
      .join('') +
    `<th style="font-size:${f.dayNum}px;width:1%;white-space:nowrap">Σч</th>` +
    `<th style="font-size:${f.dayNum}px;width:1%;white-space:nowrap">дн.</th></tr>`;
  const body = input.rows
    .map((row, i) => {
      const rc = cols.map((d) => ({ day: d, ...input.getCell(row.id, d) }));
      const tot = computeTimesheetRowTotals(rc, input.codes);
      const dayTds = cols
        .map((d) => {
          const we = weekend(d);
          return `<td style="text-align:center${we ? bodyWeekend : ''}">${cellHtml(input.getCell(row.id, d), f, we ? ink.weekendText : '#000', dayCellWidthPx)}</td>`;
        })
        .join('');
      // ФИО жирным: на принтере тонкое начертание в мелком кегле почти не читается.
      const fio = `<span style="font-size:${f.fio}px;font-weight:700">${escapeHtml(formatEmployeeSurnameInitials({ fullName: row.fullName }))}</span>`;
      return (
        `<tr style="height:${rowHeightPx}px">` +
        `<td style="text-align:center;font-size:${f.dayNum}px;width:1%;white-space:nowrap">${i + 1}</td>` +
        `<td style="text-align:left;white-space:nowrap;width:1%">${fio}</td>${dayTds}` +
        // Σч — служебная колонка, она сжата по содержимому: цифры тут не мельчим, только формат.
        `<td style="text-align:center;font-weight:700;font-size:${f.cell}px;width:1%">${escapeHtml(tot.totalHours ? formatTimesheetHours(tot.totalHours) : '')}</td>` +
        `<td style="text-align:center;font-size:${f.cell}px;width:1%">${tot.workedDays || ''}</td></tr>`
      );
    })
    .join('');
  return `<table style="font-size:${f.cell}px;table-layout:auto;width:100%">${head}${body}</table>`;
}

function legendPairs(codes: TimesheetCodeDef[]): string[] {
  return codes.map((c) => `${c.code} — ${c.title}`);
}

/** Оценка числа строк легенды на листе — нужна, чтобы отдать таблице весь остаток высоты. */
export function timesheetLegendLineCount(codes: TimesheetCodeDef[], f: TimesheetPrintFonts): number {
  const len = legendPairs(codes).join(' · ').length;
  return Math.max(1, Math.ceil((len * f.legend * 0.5) / TIMESHEET_PRINT_PAGE_PX.width));
}

function legendHtml(codes: TimesheetCodeDef[], f: TimesheetPrintFonts): string {
  return `<div style="font-size:${f.legend}px;color:#334155;line-height:1.35">${codes
    .map((c) => `<b>${escapeHtml(c.code)}</b> — ${escapeHtml(c.title)}`)
    .join(' · ')}</div>`;
}

function decodeHtml(input: TimesheetPrintInput, f: TimesheetPrintFonts): string {
  const blocks = input.rows
    .map((row) => {
      const items = input.dayList.map((d) => ({ d, comment: input.getCell(row.id, d).comment })).filter((x) => x.comment);
      if (!items.length) return '';
      return `<div style="margin-bottom:8px;font-size:${f.legend}px"><b>${escapeHtml(row.fullName || '')}</b><ul>${items
        .map((x) => `<li>${x.d} ${MONTHS[input.month - 1]} — ${escapeHtml(String(x.comment))}</li>`)
        .join('')}</ul></div>`;
    })
    .filter(Boolean)
    .join('');
  return blocks || '<div class="muted">Комментариев нет.</div>';
}

/**
 * Секции печатного листа табеля. Один набор билдеров обслуживает и живое превью диалога,
 * и окно печати — расхождения между «как выглядело» и «как напечаталось» быть не может.
 */
export function buildTimesheetPrintSections(
  input: TimesheetPrintInput,
  f: TimesheetPrintFonts,
  variant: TimesheetPrintVariant,
  blocks: TimesheetPrintBlocks,
  ink: TimesheetPrintInk,
): PrintSection[] {
  // Высота строки — весь остаток листа, делённый на число сотрудников: клетки под ручку максимально крупные.
  const rowHeightPx = timesheetPrintRowHeightPx({
    rowCount: input.rows.length,
    fonts: f,
    withHeader: blocks.header,
    legendLines: blocks.legend ? timesheetLegendLineCount(input.codes, f) : 0,
    lineWidth: ink.lineWidth,
  });
  const grid =
    variant === 'full'
      ? gridHtml(input, 1, input.days, f, rowHeightPx, ink)
      : variant === 'first'
        ? gridHtml(input, 1, 15, f, rowHeightPx, ink)
        : gridHtml(input, 16, input.days, f, rowHeightPx, ink);
  return [
    ...(blocks.header ? [{ id: 'header', title: 'Шапка листа', html: headerHtml(input, f), hideTitle: true }] : []),
    ...(blocks.grid ? [{ id: 'grid', title: 'Табель', html: grid, hideTitle: true }] : []),
    ...(blocks.legend ? [{ id: 'legend', title: 'Легенда кодов', html: legendHtml(input.codes, f), hideTitle: true }] : []),
    ...(blocks.decode
      ? [{ id: 'decode', title: 'Комментарии по сотрудникам', html: `<div style="page-break-before:always">${decodeHtml(input, f)}</div>`, hideTitle: true }]
      : []),
  ];
}
