import type { ReportTaskPeriod } from './reportTaskPeriod.js';
import type { ReportOptionSource, ReportPresetDefinition, ReportPresetFilters } from './reports.js';

/**
 * Сборка настроек отчёта из того, что удалось понять в задаче оператора: период, марки,
 * контракты, заказчики. Нужна ИИванычу, чтобы ссылка вела не просто в отчёт, а в отчёт с
 * готовым отбором.
 *
 * Раскладывает найденное по фильтрам КОНКРЕТНОГО пресета, а не по общему списку ключей:
 * у отчётов разные наборы фильтров, и «contractIds» есть не везде. Чего в пресете нет —
 * молча пропускается: лучше отчёт с частью отбора, чем отказ.
 */
export type ReportTaskEntities = {
  period?: ReportTaskPeriod | null;
  /** Найденные в тексте сущности: идентификатор + имя для подписи. */
  brands?: Array<{ id: string; name: string }>;
  contracts?: Array<{ id: string; name: string }>;
  counterparties?: Array<{ id: string; name: string }>;
};

export type ReportTaskFilters = {
  filters: ReportPresetFilters;
  /** Что именно подставлено — строкой для кнопки и ответа ИИваныча. */
  summary: string;
  /** Сколько признаков задачи удалось применить: по нему выбирается лучший пресет. */
  applied: number;
};

function optionIdsFor(source: ReportOptionSource | undefined, entities: ReportTaskEntities): Array<{ id: string; name: string }> {
  if (source === 'brands' || source === 'assemblyBrands') return entities.brands ?? [];
  if (source === 'contracts' || source === 'assembly_forecast_contracts') return entities.contracts ?? [];
  if (source === 'counterparties') return entities.counterparties ?? [];
  return [];
}

export function buildReportTaskFilters(preset: ReportPresetDefinition, entities: ReportTaskEntities): ReportTaskFilters {
  const filters: ReportPresetFilters = {};
  const parts: string[] = [];
  let applied = 0;
  let periodApplied = false;

  for (const spec of preset.filters) {
    if (spec.type === 'date_range') {
      const period = entities.period;
      // Период кладём только в ПЕРВЫЙ диапазон пресета: у отчёта по двигателям их несколько
      // (приход, начало ремонта, отгрузка), и заполнить все — значит отсечь почти всё.
      if (!period || periodApplied) continue;
      filters[spec.startKey] = period.startMs;
      filters[spec.endKey] = period.endMs;
      periodApplied = true;
      applied += 1;
      parts.push(period.label);
      continue;
    }
    if (spec.type === 'multi_select') {
      const found = optionIdsFor(spec.optionsSource, entities);
      if (found.length === 0) continue;
      filters[spec.key] = found.map((x) => x.id);
      applied += 1;
      parts.push(found.map((x) => x.name).join(', '));
      continue;
    }
  }

  // Одна и та же марка попадает в два фильтра отчёта (например, «Марки» и «Марки сборки»),
  // и подпись «Д-245, Д-245» выглядит ошибкой. Значения остаются в обоих, подпись — одна.
  const seen = new Set<string>();
  const uniqueParts = parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return { filters, summary: uniqueParts.join(', '), applied };
}

const STOP_WORDS = new Set([
  'отчет',
  'отчёт',
  'отчеты',
  'покажи',
  'показать',
  'сделай',
  'сделать',
  'нужен',
  'нужно',
  'хочу',
  'дай',
  'посмотреть',
  'вывести',
  'список',
  'данные',
  'сколько',
  'какие',
  'какой',
]);

/** Слова задачи, по которым имеет смысл искать отчёт (без «покажи», «отчёт» и прочего шума). */
export function reportTaskKeywords(task: string): string[] {
  return String(task ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/**
 * Насколько отчёт подходит задаче. Совпадение по названию весит больше, чем по описанию
 * или подписям фильтров: «наряды» в названии — это про наряды, а в списке фильтров слово
 * встречается у половины отчётов.
 */
export function scoreReportPreset(preset: ReportPresetDefinition, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const title = preset.title.toLowerCase().replace(/ё/g, 'е');
  const description = String(preset.description ?? '').toLowerCase().replace(/ё/g, 'е');
  const filterLabels = preset.filters
    .map((f) => ('label' in f ? String((f as { label?: string }).label ?? '') : ''))
    .join(' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
  let score = 0;
  for (const word of keywords) {
    // Сравниваем по основе слова: «двигателей» и «двигатели» — одно и то же.
    const stem = word.length > 5 ? word.slice(0, word.length - 2) : word;
    if (title.includes(stem)) score += 3;
    else if (description.includes(stem)) score += 2;
    else if (filterLabels.includes(stem)) score += 1;
  }
  return score;
}
