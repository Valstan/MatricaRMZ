import {
  REPORT_PRESET_DEFINITIONS,
  REPORT_PRESET_THEMES,
  buildReportLinkMarker,
  buildReportTaskFilters,
  parseReportTaskPeriod,
  reportTaskKeywords,
  scoreReportPreset,
} from '@matricarmz/shared';

import { pool } from '../../database/db.js';

/**
 * Подбор отчёта под задачу оператора вместе с ГОТОВЫМИ настройками.
 *
 * Настройки собирает сервер, а не модель: модель путает ключи фильтров и формат дат, а
 * ошибку видит только тот, кто открыл отчёт с чужим отбором. Модель получает готовую
 * строку маркера и копирует её в ответ — клиент отрисует кнопку «Открыть отчёт».
 *
 * Сущности ищутся по справочникам: из задачи берутся слова, по ним — марки, контракты и
 * заказчики, чьи названия в задаче упомянуты. Ничего не нашлось — отчёт всё равно
 * предлагается, просто без отбора.
 */
export type ReportSuggestion = {
  id: string;
  title: string;
  description: string;
  themes: readonly string[];
  /** Готовая строка для вставки в ответ. */
  marker: string;
  /** Что подставлено в фильтры, словами. */
  applied: string;
  score: number;
};

const MAX_SUGGESTIONS = 3;
const MAX_ENTITY_MATCHES = 5;
/** Короткие названия («А-41») ловятся отдельно: по общему порогу они бы не прошли. */
const MIN_NAME_LEN = 2;

type NamedRow = { id: string; name: string };

function titleWords(title: string): number {
  return String(title ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function normalize(text: string): string {
  return String(text ?? '').toLowerCase().replace(/ё/g, 'е');
}

/** Название упомянуто в задаче? Сравниваем нормализованно и по границам, а не подстрокой. */
function mentioned(haystack: string, name: string): boolean {
  const needle = normalize(name).trim();
  if (needle.length < MIN_NAME_LEN) return false;
  const at = haystack.indexOf(needle);
  if (at < 0) return false;
  const before = at === 0 ? '' : haystack[at - 1]!;
  const after = haystack[at + needle.length] ?? '';
  // «Д-245» внутри «Д-245М» — не та марка; буква или цифра по краям означает другое слово.
  return !/[a-zа-я0-9]/i.test(before) && !/[a-zа-я0-9]/i.test(after);
}

async function findMentioned(sql: string, task: string): Promise<NamedRow[]> {
  const res = await pool.query(sql);
  const out: NamedRow[] = [];
  for (const row of (res.rows ?? []) as Array<{ id?: unknown; name?: unknown }>) {
    const id = String(row.id ?? '').trim();
    const name = String(row.name ?? '').trim();
    if (!id || !name) continue;
    if (!mentioned(task, name)) continue;
    out.push({ id, name });
    if (out.length >= MAX_ENTITY_MATCHES) break;
  }
  return out;
}

/**
 * Сущности, упомянутые в задаче. Справочники читаются целиком и невелики: марок и
 * заказчиков — десятки, договоров — сотни, и каждый запрос ограничен сверху.
 */
export async function resolveReportTaskEntities(task: string): Promise<{
  brands: NamedRow[];
  contracts: NamedRow[];
  counterparties: NamedRow[];
}> {
  const text = normalize(task);
  const [brands, counterparties, contracts] = await Promise.all([
    findMentioned(`select id::text as id, name from directory_engine_brands where deleted_at is null order by name asc limit 500`, text),
    findMentioned(`select id::text as id, name from erp_counterparties where deleted_at is null order by name asc limit 500`, text),
    findMentioned(
      `select id::text as id, coalesce(nullif(number, ''), internal_number, goz_name) as name
         from erp_contracts where deleted_at is null order by created_at desc limit 500`,
      text,
    ),
  ]);
  return { brands, contracts, counterparties };
}

export async function suggestReportsForTask(task: string, now: Date = new Date()): Promise<{
  suggestions: ReportSuggestion[];
  period: string | null;
}> {
  const keywords = reportTaskKeywords(task);
  const period = parseReportTaskPeriod(task, now);
  const entities = await resolveReportTaskEntities(task).catch(() => ({ brands: [], contracts: [], counterparties: [] }));

  const scored = REPORT_PRESET_DEFINITIONS.map((preset) => {
    const built = buildReportTaskFilters(preset, {
      period,
      brands: entities.brands,
      contracts: entities.contracts,
      counterparties: entities.counterparties,
    });
    // Отчёт, который умеет принять больше найденного, поднимается: при равном совпадении по
    // словам полезнее тот, что откроется уже настроенным.
    const score = scoreReportPreset(preset, keywords) + built.applied;
    return { preset, built, score };
  })
    .filter((x) => x.score > 0)
    // Ничью разрешает краткость названия: на «покажи двигатели» точнее отчёт «Двигатели»,
    // чем «Стадии ремонта двигателей» — лишние слова в названии означают более узкую тему.
    .sort((a, b) => b.score - a.score || titleWords(a.preset.title) - titleWords(b.preset.title))
    .slice(0, MAX_SUGGESTIONS);

  return {
    period: period?.label ?? null,
    suggestions: scored.map(({ preset, built, score }) => ({
      id: String(preset.id),
      title: preset.title,
      description: preset.description,
      themes: REPORT_PRESET_THEMES[preset.id] ?? [],
      marker: buildReportLinkMarker(String(preset.id), {
        filters: built.filters,
        ...(built.summary ? { summary: built.summary } : {}),
      }),
      applied: built.summary,
      score,
    })),
  };
}
