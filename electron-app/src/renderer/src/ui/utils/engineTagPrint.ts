import { formatMoscowDate } from './dateUtils.js';
import { escapeHtml } from './printPreview.js';

/**
 * Бирки на двигатель листом A4 (запрос владельца 22.09.2026): оператор отмечает
 * несколько двигателей и печатает бирки — 6, 4 или 2 штуки на лист. Лист заполняется
 * целиком: высота бирки считается от печатной области A4, а не подбирается на глаз,
 * поэтому одна и та же раскладка печатается одинаково на любом принтере.
 *
 * Окно печати открывается тем же способом, что у QR-этикеток (`qrLabels.ts`):
 * инлайн-`<script>` в document.write-окне Electron НЕ исполняется, поэтому обработчик
 * кнопки навешивается из окна-родителя.
 */

export type EngineTagData = {
  /** Марка двигателя — вместе с номером самая крупная строка бирки. */
  engineBrand: string;
  engineNumber: string;
  customerName: string;
  /** Номер договора целиком — владелец просил не сокращать. */
  contractNumber: string;
  arrivalDate?: number | null;
  repairStartDate?: number | null;
  /**
   * Крайний день ремонта по договору (`EngineListItem.repairDueDate`): дата поступления
   * плюс срок ремонта контракта (`effectiveRepairDays`). Считает список двигателей —
   * срок лежит в секциях контракта, из бирки его не добрать.
   */
  repairDueDate?: number | null;
};

export type EngineTagsPerSheet = 6 | 4 | 2;

/** Ориентация листа (владелец 01.10.2026): бирки печатают на альбомном по умолчанию. */
export type EngineTagOrientation = 'portrait' | 'landscape';

/** Варианты раскладки для выбора оператором в печатной форме. */
export const ENGINE_TAG_PER_SHEET_OPTIONS: ReadonlyArray<EngineTagsPerSheet> = [6, 4, 2];

/** Варианты ориентации для выбора оператором в печатной форме. */
export const ENGINE_TAG_ORIENTATION_OPTIONS: ReadonlyArray<EngineTagOrientation> = ['landscape', 'portrait'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Насколько окончательная техническая приёмка позже договорного срока ремонта.
 * Отдельная именованная константа в одном месте: в базе такой даты нет, она целиком
 * вычисляемая, и владелец меняет этот запас одним движением — без правки шаблона бирки.
 */
export const TECHNICAL_ACCEPTANCE_LAG_DAYS = 10;

/** Дата окончательной технической приёмки: срок ремонта по договору плюс запас. */
export function technicalAcceptanceDate(repairDueDate: number | null | undefined): number | null {
  if (!Number.isFinite(repairDueDate as number)) return null;
  return Number(repairDueDate) + TECHNICAL_ACCEPTANCE_LAG_DAYS * DAY_MS;
}

/** Пустое место на бирке читается как «забыли заполнить», прочерк — как «данных нет». */
const DASH = '—';

const PAGE_MARGIN_MM = 7;

/**
 * Запас по высоте листа. Лист ровно в печатную область браузеры иногда округляют вверх
 * и выталкивают пустую страницу между бирками — миллиметр запаса это снимает.
 */
const SHEET_SAFETY_MM = 1;

const SHEET_WIDTH_MM = 210;
const SHEET_HEIGHT_MM = 297;

function sheetSize(orientation: EngineTagOrientation): { width: number; height: number } {
  return orientation === 'landscape'
    ? { width: SHEET_HEIGHT_MM, height: SHEET_WIDTH_MM }
    : { width: SHEET_WIDTH_MM, height: SHEET_HEIGHT_MM };
}

type TagLayout = {
  columns: number;
  rows: number;
  /** Зазор между бирками — по нему режут лист. */
  gapMm: number;
  padMm: number;
  /** Кегли: марка и номер — самые крупные, подписи полей — самые мелкие. */
  brandPt: number;
  numberPt: number;
  valuePt: number;
  labelPt: number;
};

/**
 * Наборы размеров под раскладки — одной таблицей, чтобы подбор кегля жил
 * в одном месте: чем меньше бирок на листе, тем крупнее шрифт и шире поля.
 * Компактно (владелец 01.10.2026): зазоры ужаты, кегли подняты — лист
 * заполняется текстом, а не воздухом.
 */
const TAG_LAYOUTS: Record<EngineTagsPerSheet, Record<EngineTagOrientation, TagLayout>> = {
  6: {
    portrait: { columns: 2, rows: 3, gapMm: 2, padMm: 3, brandPt: 20, numberPt: 28, valuePt: 12, labelPt: 7 },
    landscape: { columns: 3, rows: 2, gapMm: 3, padMm: 5, brandPt: 24, numberPt: 32, valuePt: 13, labelPt: 8 },
  },
  4: {
    portrait: { columns: 2, rows: 2, gapMm: 3, padMm: 5, brandPt: 30, numberPt: 40, valuePt: 16, labelPt: 9 },
    landscape: { columns: 2, rows: 2, gapMm: 4, padMm: 6, brandPt: 32, numberPt: 44, valuePt: 18, labelPt: 10 },
  },
  2: {
    portrait: { columns: 1, rows: 2, gapMm: 4, padMm: 7, brandPt: 40, numberPt: 54, valuePt: 22, labelPt: 12 },
    landscape: { columns: 2, rows: 1, gapMm: 5, padMm: 8, brandPt: 44, numberPt: 60, valuePt: 24, labelPt: 13 },
  },
};

function resolveLayout(perSheet: EngineTagsPerSheet, orientation: EngineTagOrientation): TagLayout {
  return TAG_LAYOUTS[perSheet]?.[orientation] ?? TAG_LAYOUTS[6].portrait;
}

/** Число в мм для CSS: без хвоста из плавающей точки на всю строку. */
function mm(value: number): string {
  return `${Math.round(value * 100) / 100}mm`;
}

function textOrDash(value: unknown): string {
  const text = String(value ?? '').trim();
  return text ? escapeHtml(text) : DASH;
}

function dateOrDash(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return DASH;
  return escapeHtml(formatMoscowDate(Number(value)));
}

function renderField(label: string, value: string): string {
  return `<div class="tag-field">
      <div class="tag-label">${escapeHtml(label)}</div>
      <div class="tag-value">${value}</div>
    </div>`;
}

/**
 * Три последние цифры части номера до «/» (владелец 01.10.2026): именно по ним
 * цех опознаёт договор, поэтому на бирке они жирные и крупные. Нет цифр —
 * null, печатается целиком как раньше.
 */
export function splitContractDigits(raw: string): { head: string; digits: string; tail: string } | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  const pre = slash >= 0 ? text.slice(0, slash) : text;
  const m = /(\d{3})\s*$/.exec(pre);
  if (!m || m[1] === undefined) return null;
  return { head: pre.slice(0, m.index), digits: m[1], tail: text.slice(pre.length) };
}

function contractValue(raw: string): string {
  const parts = splitContractDigits(raw);
  if (!parts) return textOrDash(raw);
  return `${escapeHtml(parts.head)}<span class="tag-contract-digits">${escapeHtml(parts.digits)}</span>${escapeHtml(parts.tail)}`;
}

function renderTag(tag: EngineTagData): string {
  return `<div class="tag">
    <div class="tag-head">
      <div class="tag-brand">${textOrDash(tag.engineBrand)}</div>
      <div class="tag-number">${textOrDash(tag.engineNumber)}</div>
    </div>
    <div class="tag-body">
      ${renderField('Заказчик', textOrDash(tag.customerName))}
      ${renderField('Договор', contractValue(tag.contractNumber))}
      ${renderField('Поступил на завод', dateOrDash(tag.arrivalDate))}
      ${renderField('Начало ремонта', dateOrDash(tag.repairStartDate))}
      ${renderField('Окончание ремонта по договору', dateOrDash(tag.repairDueDate))}
      ${renderField('Окончательная техническая приёмка', dateOrDash(technicalAcceptanceDate(tag.repairDueDate)))}
    </div>
  </div>`;
}

function buildCss(layout: TagLayout, orientation: EngineTagOrientation): string {
  const { width: sheetWidth, height: sheetHeight } = sheetSize(orientation);
  const contentWidth = sheetWidth - 2 * PAGE_MARGIN_MM;
  const contentHeight = sheetHeight - 2 * PAGE_MARGIN_MM - SHEET_SAFETY_MM;
  // Высота бирки — остаток печатной области, поделённый на число рядов: лист заполняется
  // целиком, «на глаз» тут ничего не задаётся.
  const cellHeight = (contentHeight - layout.gapMm * (layout.rows - 1)) / layout.rows;
  const digitsPt = layout.valuePt + 6;
  return `
  * { box-sizing: border-box; }
  body { font-family: system-ui, Arial, sans-serif; margin: 0; color: #0b1220; background: #e7e9ef; }
  .no-print { padding: 10px 14px; display: flex; gap: 10px; align-items: center; }
  .no-print button { border: 1px solid #cbd5f5; background: #2563eb; color: #fff; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
  .no-print .muted { color: #6b7280; font-size: 12px; }
  .sheet {
    background: #fff;
    margin: 0 auto 8mm auto;
    padding: 0;
    width: ${mm(contentWidth)};
    height: ${mm(contentHeight)};
    display: grid;
    grid-template-columns: repeat(${layout.columns}, 1fr);
    grid-template-rows: repeat(${layout.rows}, ${mm(cellHeight)});
    gap: ${mm(layout.gapMm)};
  }
  .sheet:last-child { margin-bottom: 0; }
  .tag {
    border: 1px dashed #94a3b8;
    padding: ${mm(layout.padMm)};
    display: flex;
    flex-direction: column;
    gap: ${mm(layout.padMm / 2)};
    overflow: hidden;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .tag-head { border-bottom: 1px solid #0b1220; padding-bottom: ${mm(layout.padMm / 2)}; }
  .tag-brand { font-size: ${layout.brandPt}pt; font-weight: 700; line-height: 1.1; word-break: break-word; }
  .tag-number { font-size: ${layout.numberPt}pt; font-weight: 800; line-height: 1.1; word-break: break-word; font-variant-numeric: tabular-nums; }
  .tag-body { display: flex; flex-direction: column; justify-content: space-between; flex: 1 1 auto; min-height: 0; }
  .tag-field { min-width: 0; }
  .tag-label { font-size: ${layout.labelPt}pt; color: #6b7280; line-height: 1.1; text-transform: uppercase; letter-spacing: 0.2px; }
  .tag-value { font-size: ${layout.valuePt}pt; font-weight: 700; line-height: 1.15; word-break: break-word; }
  .tag-contract-digits { font-size: ${digitsPt}pt; font-weight: 800; }
  @page { size: A4${orientation === 'landscape' ? ' landscape' : ''}; margin: ${mm(PAGE_MARGIN_MM)}; }
  @media print {
    body { background: #fff; }
    .no-print { display: none !important; }
    .sheet { margin: 0; break-after: page; page-break-after: always; }
    .sheet:last-child { break-after: auto; page-break-after: auto; }
  }`;
}

/**
 * Собирает печатный HTML бирок. Бирки режутся на листы ПО РАСКЛАДКЕ (по perSheet штук
 * в блоке `.sheet`), а не отдаются одной лентой: так число листов детерминировано и
 * не зависит от того, как браузер посчитает перенос сетки.
 */
export function buildEngineTagsHtml(
  tags: ReadonlyArray<EngineTagData>,
  opts: { perSheet: EngineTagsPerSheet; orientation: EngineTagOrientation },
): string {
  const perSheet = opts.perSheet;
  const orientation = opts.orientation;
  const layout = resolveLayout(perSheet, orientation);
  const sheets: string[] = [];
  for (let i = 0; i < tags.length; i += perSheet) {
    const chunk = tags.slice(i, i + perSheet).map(renderTag).join('\n');
    sheets.push(`<div class="sheet">${chunk}</div>`);
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Бирки на двигатели</title>
  <style>${buildCss(layout, orientation)}</style>
</head>
<body>
  <div class="no-print">
    <button id="printBtn" type="button">Печать / PDF</button>
    <span class="muted">Бирок: ${tags.length} · на листе: ${perSheet} · ${orientation === 'landscape' ? 'альбом' : 'портрет'} · листов: ${sheets.length}</span>
  </div>
  ${sheets.join('\n')}
  <script>
    var b = document.getElementById('printBtn');
    if (b) b.addEventListener('click', function(){ window.print(); });
  </script>
</body>
</html>`;
}

/** Открывает окно печати бирок. Возвращает число напечатанных бирок. */
export function openEngineTagsPrint(
  tags: ReadonlyArray<EngineTagData>,
  opts: { perSheet: EngineTagsPerSheet; orientation: EngineTagOrientation },
): number {
  if (tags.length === 0) return 0;
  const html = buildEngineTagsHtml(tags, opts);
  const w = window.open('', '_blank');
  if (!w) return 0;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    const printBtn = w.document.getElementById('printBtn');
    if (printBtn) printBtn.addEventListener('click', () => w.print());
    w.focus();
  }, 200);
  return tags.length;
}
