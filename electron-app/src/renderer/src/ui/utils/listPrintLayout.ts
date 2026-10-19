/**
 * Раскладка печати списка: сколько колонок влезает на лист, каким кеглем и в какой
 * ориентации. Считается ДО печати, потому что браузерная раскладка `auto` решает ту же
 * задачу по-своему — и решает плохо: широкий список вылезает за правый край листа, а
 * обрезанные колонки оператор не видит вовсе.
 *
 * `table-layout: fixed` + ширины из `<colgroup>` делают результат предсказуемым: сумма
 * ширин равна печатной области, поэтому «уехать за край» физически нечему. Цена —
 * колонку, которой не хватило места, приходится называть оператору вслух; за это
 * отвечает `clippedLabels`.
 */
export type PrintOrientation = 'portrait' | 'landscape';
export type PrintOrientationChoice = 'auto' | PrintOrientation;

export type PrintColumnSpec = {
  /** Заголовок колонки: по его самому длинному слову считается минимум ширины. */
  label: string;
  /** Самое длинное значение колонки в символах (0 — значений нет). */
  valueChars: number;
};

export type PrintLayoutPlan = {
  orientation: PrintOrientation;
  /** Кегль таблицы, pt. */
  fontSizePt: number;
  /** Ширины всех колонок в мм; первая — «№». */
  widthsMm: number[];
  /** Колонки, которым не хватило места даже на минимальном кегле. */
  clippedLabels: string[];
  /** Ширина таблицы в мм — ровно печатная область листа. */
  tableWidthMm: number;
};

export const PRINT_MARGIN_MM = 12;
/** Колонка «№» — фиксированная: номер не длиннее пяти знаков даже в большом списке. */
export const ROW_NUMBER_COLUMN_MM = 8;
export const PRINT_FONT_STEPS = [12, 10, 9, 8] as const;

const PAGE_WIDTH_MM: Record<PrintOrientation, number> = { portrait: 210, landscape: 297 };
const PAGE_HEIGHT_MM: Record<PrintOrientation, number> = { portrait: 297, landscape: 210 };
/**
 * Средняя ширина знака ≈ 0.5em; в мм при кегле pt: pt × 0.3528 × 0.5. Замер вживую
 * (canvas, Segoe UI, смоук 19.10.2026): обычный текст — 0.167…0.203, в среднем 0.184;
 * берём 0.19 — с запасом на цифры и латиницу в верхнем регистре («TEST-BRAND» — 0.203).
 */
const CHAR_MM_PER_PT = 0.19;
/** Горизонтальные отступы ячейки (6px 8px) плюс запас на границу. */
const CELL_PADDING_MM = 4.4;
const MIN_COLUMN_MM = 6;
const MAX_COLUMN_MM = 90;
/** Длиннее значения в расчёт не берём: такая ячейка всё равно переносится на строки. */
const MAX_VALUE_CHARS = 45;
/** Минимум по заголовку: самое длинное слово должно влезть, иначе шапка нечитаема. */
const MAX_LABEL_WORD_CHARS = 14;
/**
 * Заголовок печатается жирным, а `CHAR_MM_PER_PT` мерен по обычному тексту. Тот же замер:
 * жирная шапка — 0.185…0.234 в среднем 0.205, и хуже всего короткие слова с широкими
 * буквами («Номер» — 0.234): именно они рвались посередине, пока запас был меньше.
 * 0.234 / 0.19 = 1.23 — держим минимум по худшему замеренному слову, а не по среднему.
 */
const HEADER_BOLD_FACTOR = 1.23;

export function printableWidthMm(orientation: PrintOrientation): number {
  return PAGE_WIDTH_MM[orientation] - 2 * PRINT_MARGIN_MM;
}

export function printableHeightMm(orientation: PrintOrientation): number {
  return PAGE_HEIGHT_MM[orientation] - 2 * PRINT_MARGIN_MM;
}

function longestWord(label: string): number {
  return String(label ?? '')
    .split(/\s+/)
    .reduce((max, word) => Math.max(max, word.length), 0);
}

/** Ширина по значениям колонки: сколько знаков бывает в самой длинной ячейке. */
function valueMm(spec: PrintColumnSpec, pt: number): number {
  const chars = Math.max(3, Math.min(MAX_VALUE_CHARS, spec.valueChars));
  return chars * pt * CHAR_MM_PER_PT + CELL_PADDING_MM;
}

/** Ширина по самому длинному слову заголовка — жирного, поэтому с запасом. */
function headerMm(spec: PrintColumnSpec, pt: number, maxChars: number): number {
  const chars = Math.max(3, Math.min(maxChars, longestWord(spec.label)));
  return chars * pt * CHAR_MM_PER_PT * HEADER_BOLD_FACTOR + CELL_PADDING_MM;
}

function desiredMm(spec: PrintColumnSpec, pt: number): number {
  // Колонка обязана вместить и своё самое длинное значение, и самое длинное слово шапки.
  return Math.min(MAX_COLUMN_MM, Math.max(valueMm(spec, pt), headerMm(spec, pt, MAX_LABEL_WORD_CHARS)));
}

function minimumMm(spec: PrintColumnSpec, pt: number, desired: number): number {
  return Math.min(desired, headerMm(spec, pt, 12));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Вниз, а не к ближайшему: ширины округляются порознь, и «ближайшее» на восьми колонках
 * даёт лишние полмиллиметра — ровно то, из-за чего правый край снова уезжает.
 */
function roundWidths(widths: readonly number[]): number[] {
  return widths.map((w) => Math.floor(w * 10) / 10);
}

/** После округления сумма может вылезти за лист на десятые — возвращаем её в границы. */
function fitToWidth(widths: readonly number[], availableMm: number): number[] {
  const excess = sum(widths) - availableMm;
  if (excess <= 0.05) return [...widths];
  const reducible = widths.map((w) => Math.max(0, w - MIN_COLUMN_MM));
  const totalReducible = sum(reducible);
  if (totalReducible <= 0) return [...widths];
  return widths.map((w, i) => w - (excess * (reducible[i] ?? 0)) / totalReducible);
}

/**
 * Разложить колонки по доступной ширине. Сначала пробуем желаемую ширину (по содержимому);
 * не влезло — отдаём свободное место пропорционально недостающему, но не ниже минимума по
 * заголовку; не влезли даже минимумы — сжимаем всё и называем урезанные колонки.
 */
function fitColumns(
  columns: readonly PrintColumnSpec[],
  pt: number,
  availableMm: number,
): { widths: number[]; fits: boolean; clippedLabels: string[] } {
  const desired = columns.map((c) => desiredMm(c, pt));
  if (sum(desired) <= availableMm) return { widths: desired, fits: true, clippedLabels: [] };

  const minimum = columns.map((c, i) => minimumMm(c, pt, desired[i] ?? 0));
  if (sum(minimum) <= availableMm) {
    const slack = availableMm - sum(minimum);
    const weights = desired.map((d, i) => Math.max(0, d - (minimum[i] ?? 0)));
    const totalWeight = sum(weights);
    const widths = minimum.map((m, i) => {
      const weight = weights[i] ?? 0;
      return totalWeight > 0 ? m + (slack * weight) / totalWeight : m + slack / columns.length;
    });
    return { widths, fits: true, clippedLabels: [] };
  }

  const scale = availableMm / sum(minimum);
  const scaled = minimum.map((m) => Math.max(MIN_COLUMN_MM, m * scale));
  const scaledSum = sum(scaled);
  const widths = scaledSum > availableMm ? scaled.map((w) => (w * availableMm) / scaledSum) : scaled;
  const clippedLabels = columns
    .map((c, i) => ({ label: c.label, width: widths[i] ?? 0, minimum: minimum[i] ?? 0 }))
    .filter((column) => column.width + 0.01 < column.minimum)
    .map((column) => column.label);
  return { widths, fits: false, clippedLabels };
}

function planFor(orientation: PrintOrientation, columns: readonly PrintColumnSpec[]): PrintLayoutPlan[] {
  const tableWidthMm = printableWidthMm(orientation);
  const availableMm = tableWidthMm - ROW_NUMBER_COLUMN_MM;
  return PRINT_FONT_STEPS.map((fontSizePt) => {
    const fit = fitColumns(columns, fontSizePt, availableMm);
    return {
      orientation,
      fontSizePt,
      widthsMm: [ROW_NUMBER_COLUMN_MM, ...roundWidths(fitToWidth(fit.widths, availableMm))],
      clippedLabels: fit.clippedLabels,
      tableWidthMm,
    };
  });
}

/**
 * Подбор ориентации и кегля. «Авто» выбирает план с самым крупным кеглем: повернуть лист
 * ради читаемых 12 pt лучше, чем ужать список до 8 pt на книжном. При равном кегле остаётся
 * книжная — её и ждёт оператор; при равном числе урезанных колонок тоже она.
 *
 * `fontSizePt` прибивает кегль: так переключатель кегля в окне предпросмотра пересчитывает
 * ширины той же раскладкой, а не оставляет колонки от прежнего размера.
 */
export function planListPrintLayout(opts: {
  columns: readonly PrintColumnSpec[];
  orientation?: PrintOrientationChoice;
  fontSizePt?: number;
}): PrintLayoutPlan {
  const choice = opts.orientation ?? 'auto';
  const orientations: PrintOrientation[] = choice === 'auto' ? ['portrait', 'landscape'] : [choice];
  const candidates = orientations
    .flatMap((orientation) => planFor(orientation, opts.columns))
    .filter((plan) => opts.fontSizePt == null || plan.fontSizePt === opts.fontSizePt);
  const fitting = candidates.filter((plan) => plan.clippedLabels.length === 0);
  if (fitting.length > 0) {
    return fitting.reduce((best, plan) => {
      if (plan.fontSizePt !== best.fontSizePt) return plan.fontSizePt > best.fontSizePt ? plan : best;
      return best;
    });
  }
  // Ни один вариант не влез: показываем самый мелкий кегль (при равных потерях он покажет
  // больше знаков), а при равном кегле — альбомный лист: колонки шире, читать легче.
  return candidates.reduce((best, plan) => {
    if (plan.clippedLabels.length !== best.clippedLabels.length) {
      return plan.clippedLabels.length < best.clippedLabels.length ? plan : best;
    }
    if (plan.fontSizePt !== best.fontSizePt) return plan.fontSizePt < best.fontSizePt ? plan : best;
    return plan.orientation === 'landscape' ? plan : best;
  });
}
