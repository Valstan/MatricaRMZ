import type { ReportFilterOption, ReportFilterSpec, ReportPresetDefinition, ReportPresetFilters } from './reports.js';

/**
 * Описание настроек отчёта человеческими словами (владелец 12.09.2026: «чтобы название и
 * коротенькое описание — что он выбирает, какие поля, за какой период; глазами пробежаться»).
 *
 * Настройки хранятся идентификаторами («контракт `770b2cb9…`»), а показывать их нужно именами.
 * Имена живут в вариантах фильтров (`ReportFilterOption`), которые отдаёт каталог отчётов
 * вместе с пресетами, поэтому функция берёт их снаружи, а не ходит в базу.
 */
export type ReportOptionLabelLookup = {
  /** Варианты по источнику (`contracts`, `brands`, …) — как их отдаёт каталог. */
  optionSets?: Partial<Record<string, ReportFilterOption[]>>;
};

/** Одна строка описания: подпись фильтра и то, что в нём выбрано. */
export type ReportFilterSummaryPart = { label: string; value: string };

const MAX_LISTED_VALUES = 3;

function formatDay(ms: unknown): string | null {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  if (n == null || n <= 0) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function optionsOf(spec: ReportFilterSpec, lookup: ReportOptionLabelLookup): ReportFilterOption[] {
  if ('options' in spec && Array.isArray(spec.options) && spec.options.length > 0) return spec.options;
  const source = 'optionsSource' in spec ? spec.optionsSource : undefined;
  if (!source) return [];
  return lookup.optionSets?.[String(source)] ?? [];
}

function labelForValue(spec: ReportFilterSpec, lookup: ReportOptionLabelLookup, value: string): string {
  const found = optionsOf(spec, lookup).find((o) => String(o.value) === value);
  return found ? String(found.label ?? value) : value;
}

function describeMany(spec: ReportFilterSpec, lookup: ReportOptionLabelLookup, values: string[]): string {
  const labels = values.map((v) => labelForValue(spec, lookup, v));
  if (labels.length <= MAX_LISTED_VALUES) return labels.join(', ');
  // Длинный список именами нечитаем: показываем первые и «и ещё N».
  const head = labels.slice(0, MAX_LISTED_VALUES).join(', ');
  return `${head} и ещё ${labels.length - MAX_LISTED_VALUES}`;
}

/**
 * Разбирает настройки в строки «подпись → выбранное». Пустые, дефолтные и служебные
 * (настройка печати) фильтры пропускаются: в описании нужно то, чем отчёт отличается
 * от соседнего, а не полный список полей.
 */
export function summarizeReportFilters(
  preset: ReportPresetDefinition | undefined,
  filters: ReportPresetFilters | undefined,
  lookup: ReportOptionLabelLookup = {},
  disabled: string[] = [],
): ReportFilterSummaryPart[] {
  if (!preset || !filters) return [];
  const off = new Set(disabled.map((x) => String(x ?? '').trim()).filter(Boolean));
  const parts: ReportFilterSummaryPart[] = [];
  for (const spec of preset.filters) {
    if (off.has(spec.key)) continue;
    switch (spec.type) {
      case 'date_range': {
        const from = formatDay(filters[spec.startKey]);
        const to = formatDay(filters[spec.endKey]);
        if (!from && !to) continue;
        if (from && to) parts.push({ label: spec.label, value: from === to ? from : `${from} — ${to}` });
        else parts.push({ label: spec.label, value: from ? `с ${from}` : `по ${to}` });
        break;
      }
      case 'multi_select': {
        const raw = filters[spec.key];
        const values = Array.isArray(raw) ? raw.map((v) => String(v ?? '')).filter(Boolean) : [];
        // Пустой множественный фильтр означает «все» — упоминать его незачем.
        if (values.length === 0) continue;
        parts.push({ label: spec.label, value: describeMany(spec, lookup, values) });
        break;
      }
      case 'select': {
        const value = String(filters[spec.key] ?? '').trim();
        if (!value) continue;
        const options = optionsOf(spec, lookup);
        // Первый вариант — значение по умолчанию: оно не отличает этот отчёт от соседнего.
        if (options.length > 0 && String(options[0]?.value ?? '') === value) continue;
        parts.push({ label: spec.label, value: labelForValue(spec, lookup, value) });
        break;
      }
      case 'checkbox': {
        const value = filters[spec.key];
        if (typeof value !== 'boolean') continue;
        if (value === Boolean(spec.defaultValue)) continue;
        parts.push({ label: spec.label, value: value ? 'да' : 'нет' });
        break;
      }
      case 'number': {
        const value = filters[spec.key];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        if (spec.defaultValue != null && value === spec.defaultValue) continue;
        parts.push({ label: spec.label, value: String(value) });
        break;
      }
      case 'text': {
        const value = String(filters[spec.key] ?? '').trim();
        if (!value) continue;
        parts.push({ label: spec.label, value });
        break;
      }
      default:
        // print_layout и прочее служебное в описание не идёт.
        break;
    }
  }
  return parts;
}

/** Та же сводка одной строкой — для карточки списка. */
export function formatReportFiltersSummary(
  preset: ReportPresetDefinition | undefined,
  filters: ReportPresetFilters | undefined,
  lookup: ReportOptionLabelLookup = {},
  disabled: string[] = [],
): string {
  const parts = summarizeReportFilters(preset, filters, lookup, disabled);
  if (parts.length === 0) return 'без отбора — все данные';
  return parts.map((p) => `${p.label}: ${p.value}`).join(' · ');
}
