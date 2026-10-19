import { facetRangeOf, type FacetSelection } from './listFacets.js';

/**
 * Строки шапки печати (и выгрузок) человеческим языком: «Вид работ: Укладка вала ·
 * Цех: Сборка», «Поиск: «вал»». Печатается то, что оператор видит в списке, — и если
 * в шапке нет применённого отбора, лист врёт о том, что на нём напечатано.
 *
 * Ступени описывают себя сами: подпись и выбранные значения уже есть в
 * `FacetDescriptor`/`FacetSelection`, поэтому страница передаёт то же состояние, что и
 * фильтру, и не собирает подписи руками (иначе шапка разъедется с фильтром).
 */
export type FacetSummaryExtra = {
  /** Поиск по списку — печатается строкой «Поиск: «…»». */
  search?: string;
  /** Период списка, не выраженный ступенью: «всё время», «октябрь 2026». */
  period?: string;
  /** Группировка строк: «по этапам», «по двигателям». */
  grouping?: string;
  /** Готовые строки страницы для отборов, которых нет среди ступеней (тип, склад). */
  extra?: readonly string[];
};

/**
 * Из ступени для подписи нужны только вид, подпись и ряд значений: поля ввода строки тут
 * ни при чём, поэтому страница передаёт свой `FacetDescriptor` как есть — без приведения
 * к типу строки списка и без второй копии списка ступеней.
 */
export type FacetSummarySpec =
  | { kind: 'values'; id: string; label: string; options?: readonly { value: string; label: string }[] }
  | { kind: 'dateRange'; id: string; label: string };

const MAX_LISTED_VALUES = 6;

/**
 * Дата из `YYYY-MM-DD` — как её пишет оператор: «01.10.2026». Не разобралось — возвращаем
 * как есть: показать исходное значение честнее, чем спрятать отбор из шапки.
 */
export function formatDayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function rangeLabel(range: { from?: string; to?: string }): string {
  const from = range.from ? formatDayLabel(range.from) : '';
  const to = range.to ? formatDayLabel(range.to) : '';
  if (from && to) return from === to ? from : `с ${from} по ${to}`;
  if (from) return `с ${from}`;
  return `по ${to}`;
}

function valuesLabel(facet: Extract<FacetSummarySpec, { kind: 'values' }>, selected: readonly string[]): string {
  const labelByValue = new Map((facet.options ?? []).map((o) => [o.value, o.label]));
  const labels = selected.map((v) => labelByValue.get(v) ?? v);
  if (labels.length <= MAX_LISTED_VALUES) return labels.join(', ');
  return `${labels.slice(0, MAX_LISTED_VALUES).join(', ')} и ещё ${labels.length - MAX_LISTED_VALUES}`;
}

/**
 * Один абзац на ступени (через « · ») плюс отдельные строки поиска, периода и
 * группировки. Пустой отбор даёт пустой список: страница тогда не печатает строку
 * отбора вовсе, а не «Фильтры: нет».
 */
export function describeFacetSelection(
  facets: readonly FacetSummarySpec[],
  selection: FacetSelection,
  extra?: FacetSummaryExtra,
): string[] {
  const parts: string[] = [];
  for (const facet of facets) {
    if (facet.kind === 'dateRange') {
      const range = facetRangeOf(selection, facet.id);
      if (range) parts.push(`${facet.label}: ${rangeLabel(range)}`);
      continue;
    }
    const raw = selection[facet.id];
    const selected = Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
    if (selected.length > 0) parts.push(`${facet.label}: ${valuesLabel(facet, selected)}`);
  }

  const lines: string[] = [];
  if (parts.length > 0) lines.push(parts.join(' · '));
  const search = String(extra?.search ?? '').trim();
  if (search) lines.push(`Поиск: «${search}»`);
  const period = String(extra?.period ?? '').trim();
  if (period) lines.push(`Период: ${period}`);
  const grouping = String(extra?.grouping ?? '').trim();
  if (grouping) lines.push(`Группировка: ${grouping}`);
  for (const line of extra?.extra ?? []) {
    const text = String(line ?? '').trim();
    if (text) lines.push(text);
  }
  return lines;
}

const MONTH_NAMES = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

/**
 * Значение `<input type="month">` (`YYYY-MM`) человеческим языком: «октябрь 2026».
 * Битое или пустое значение даёт пустую строку — страница тогда не печатает строку периода
 * вовсе, а не «Период: 2026-13».
 */
export function formatMonthLabel(value: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return '';
  const month = Number(m[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return '';
  return `${MONTH_NAMES[month - 1] ?? ''} ${m[1]}`;
}
