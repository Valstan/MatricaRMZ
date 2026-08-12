import type { ReportColumn } from './reports.js';

/**
 * Настройки печатной формы отчёта, которые оператор крутит сам: размер шрифта таблицы,
 * шрифт отдельных колонок и список исключённых колонок.
 *
 * Живёт в значениях фильтров пресета (ключ `printLayout`), поэтому сохраняется в шаблонах
 * фильтров вместе с отбором: подобранная под свою бумагу раскладка переживает перезапуск.
 */
export type ReportPrintLayout = {
  /** Базовый размер шрифта таблицы, px. */
  basePx: number;
  /** Размер шрифта шапки таблицы, px. */
  headerPx: number;
  /** Ключи колонок, исключённых из отчёта (не печатаются и не попадают в выгрузки). */
  hidden: string[];
  /** Переопределение размера шрифта по колонке, px. Нет ключа — берётся `basePx`. */
  fontPx: Record<string, number>;
  /** Необязательные блоки печатной формы (своды, подытоги): ключ блока → печатать ли. */
  sections?: Record<string, boolean>;
};

export const MIN_REPORT_PRINT_FONT_PX = 6;
export const MAX_REPORT_PRINT_FONT_PX = 28;

function clampFontPx(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(MAX_REPORT_PRINT_FONT_PX, Math.max(MIN_REPORT_PRINT_FONT_PX, Math.round(num)));
}

/**
 * Приводит сырое значение фильтра к раскладке: пришло из шаблона фильтров, из IPC или
 * вовсе отсутствует. Незнакомые ключи шрифтов отбрасываются, обязательные колонки
 * (`requiredKeys`) нельзя спрятать — на них держится иерархия печатной формы.
 */
export function resolveReportPrintLayout(
  raw: unknown,
  defaults: ReportPrintLayout,
  options?: { columns?: readonly ReportColumn[]; requiredKeys?: readonly string[] },
): ReportPrintLayout {
  const source = raw && typeof raw === 'object' ? (raw as Partial<ReportPrintLayout>) : {};
  const known = options?.columns ? new Set(options.columns.map((c) => c.key)) : null;
  const required = new Set(options?.requiredKeys ?? []);

  const hidden = Array.isArray(source.hidden)
    ? Array.from(
        new Set(
          source.hidden
            .map((key) => String(key))
            .filter((key) => !required.has(key) && (!known || known.has(key))),
        ),
      )
    : [...defaults.hidden];

  const fontPx: Record<string, number> = { ...defaults.fontPx };
  if (source.fontPx && typeof source.fontPx === 'object') {
    for (const [key, value] of Object.entries(source.fontPx as Record<string, unknown>)) {
      if (known && !known.has(key)) continue;
      if (value == null || value === '') {
        delete fontPx[key];
        continue;
      }
      fontPx[key] = clampFontPx(value, defaults.fontPx[key] ?? defaults.basePx);
    }
  }

  const sections = { ...(defaults.sections ?? {}) };
  if (source.sections && typeof source.sections === 'object') {
    for (const [key, value] of Object.entries(source.sections as Record<string, unknown>)) {
      sections[key] = Boolean(value);
    }
  }

  return {
    basePx: clampFontPx(source.basePx, defaults.basePx),
    headerPx: clampFontPx(source.headerPx, defaults.headerPx),
    hidden,
    fontPx,
    ...(Object.keys(sections).length > 0 ? { sections } : {}),
  };
}

/** Печатать ли необязательный блок формы (по умолчанию — да). */
export function isPrintSectionEnabled(layout: ReportPrintLayout, key: string): boolean {
  const value = layout.sections?.[key];
  return value == null ? true : value;
}

/** Размер шрифта конкретной колонки: переопределение оператора, иначе базовый. */
export function reportColumnFontPx(layout: ReportPrintLayout, columnKey: string): number {
  const own = layout.fontPx[columnKey];
  return typeof own === 'number' && Number.isFinite(own) ? own : layout.basePx;
}

/** Колонки без исключённых оператором — в исходном (каноническом) порядке. */
export function visibleReportColumns(columns: readonly ReportColumn[], layout: ReportPrintLayout): ReportColumn[] {
  const hidden = new Set(layout.hidden);
  return columns.filter((column) => !hidden.has(column.key));
}
