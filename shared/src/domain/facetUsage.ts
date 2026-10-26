/**
 * Рейтинг ступеней фильтра (владелец 25.10.2026: «чем чаще фильтр выбирается, тем левее он
 * должен стоять в ряду») и значений внутри ступени (владелец 26.10.2026: «показывать только
 * пять самых рейтинговых, остальные под спойлером — а то все заказчики разом и рябит в глазах»).
 *
 * Счёт копится по дням с затуханием — тем же правилом, что размер плитки Верстака
 * (`desktopUsage*`): ступень, которой месяц не пользовались, сама уезжает вправо, и ручной
 * чистки не нужно. Окно и период полураспада живут здесь, а не в интерфейсе: иначе два списка
 * начали бы считать порядок по-разному.
 *
 * Почему порядок «просаживается» плавно, а не считается по абсолютному числу щелчков: список
 * фильтров — не витрина достижений. Заброшенный фильтр не должен держать левый край вечно, а
 * равные счета на старте (у всех ноль) обязаны сохранять исходный порядок — иначе ряд кнопок
 * перетасовался бы у оператора на первом же открытии.
 */

export type FacetUsage = { buckets: Record<string, Record<string, number>> };

export const FACET_USAGE_MAX_DAYS = 30;
/**
 * Сколько ступеней и значений видно в панели сразу, без спойлера (владелец 26.10.2026:
 * «показывать только пять самых рейтинговых, остальные под спойлером — а то рябит в глазах»).
 * Число живёт здесь, а не в интерфейсе: ряд кнопок и список значений режутся одинаково.
 */
export const FACET_USAGE_VISIBLE_LIMIT = 5;
const MAX_USAGE_COUNT = 1_000_000;
const USAGE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Потолок ключа счёта: он же стоит в санитайзере, иначе после перезапуска счёт не найдётся. */
const FACET_USAGE_ID_MAX = 120;
/** Неделя простоя делит счёт пополам. */
const USAGE_HALF_LIFE_DAYS = 7;

export function createEmptyFacetUsage(): FacetUsage {
  return { buckets: {} };
}

/** День бакета по МЕСТНОМУ времени: «сегодня» у оператора — по его часам, не по UTC. */
export function facetUsageDay(ts: number): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dayIndex(day: string): number {
  const [y, m, d] = day.split('-').map((x) => Number(x));
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/** Дни за окном выбрасываются: иначе карта растёт бесконечно, а санитайзер режет её молча. */
function trimDays(days: Record<string, number>, now: number): Record<string, number> {
  const oldest = dayIndex(facetUsageDay(now)) - FACET_USAGE_MAX_DAYS + 1;
  const out: Record<string, number> = {};
  for (const [day, count] of Object.entries(days)) {
    if (!USAGE_DAY_RE.test(day) || count <= 0) continue;
    if (dayIndex(day) < oldest) continue;
    out[day] = Math.min(MAX_USAGE_COUNT, Math.trunc(count));
  }
  return out;
}

/** +1 к ступени: оператор открыл её или выбрал в ней значение. */
export function facetUsageBump(usage: FacetUsage, facetId: string, now: number): FacetUsage {
  const id = facetId.trim().slice(0, FACET_USAGE_ID_MAX);
  if (!id) return usage;
  const day = facetUsageDay(now);
  const prev = usage.buckets[id] ?? {};
  const days = trimDays({ ...prev, [day]: (prev[day] ?? 0) + 1 }, now);
  return { buckets: { ...usage.buckets, [id]: days } };
}

/** Счёт ступени: сумма дней с весом `0.5^(возраст/7)`. */
export function facetUsageScore(usage: FacetUsage, facetId: string, now: number): number {
  const days = usage.buckets[facetId.trim()];
  if (!days) return 0;
  const today = dayIndex(facetUsageDay(now));
  let score = 0;
  for (const [day, count] of Object.entries(days)) {
    const age = today - dayIndex(day);
    if (age < 0 || age >= FACET_USAGE_MAX_DAYS) continue;
    score += count * Math.pow(0.5, age / USAGE_HALF_LIFE_DAYS);
  }
  return score;
}

/**
 * Порядок ступеней для ряда кнопок: частые — слева. Ничьи сохраняют исходный порядок (сортировка
 * устойчивая), поэтому пока счётчики пусты, ряд выглядит ровно так, как задан в описании ступеней.
 * Незнакомые счётчику ступени не теряются: они просто стоят на своих местах с нулём.
 */
export function orderFacetIdsByUsage(ids: readonly string[], usage: FacetUsage, now: number): string[] {
  return ids
    .map((id, index) => ({ id, index, score: facetUsageScore(usage, id, now) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.id);
}

/**
 * Ключ счёта значения ступени: `customer|8f14e45f-…`.
 *
 * Счёт значений живёт в той же карте, что счёт ступеней, и различается префиксом с разделителем:
 * `|` не встречается ни в одном id ступени, поэтому «ступень `customer`» и «значение `customer`
 * ступени x» не могут слиться в один ключ случайно.
 */
export function facetValueUsageId(facetId: string, value: string): string {
  return `${facetId.trim()}|${String(value ?? '').trim()}`.slice(0, FACET_USAGE_ID_MAX);
}

/** Счёт одного значения ступени — то же затухание, что у ступени. */
export function facetValueScore(usage: FacetUsage, facetId: string, value: string, now: number): number {
  return facetUsageScore(usage, facetValueUsageId(facetId, value), now);
}

export type RatedSplit<T> = { visible: T[]; hidden: T[] };

/**
 * Ряд по рейтингу → «видно сразу» и «под спойлером».
 *
 * Видимая часть — до `limit` самых рейтинговых, но **обязательные** (`keep`) не прячутся за
 * спойлер никогда: активная ступень и выбранное значение иначе отбирали бы втихую, а снять
 * выбор было бы нечем. Хвост остаётся упорядоченным по тому же рейтингу — в спойлере частые
 * тоже выше редких.
 */
export function splitRatedByUsage<T>(
  items: readonly T[],
  scoreOf: (item: T) => number,
  keep: (item: T) => boolean = () => false,
  limit: number = FACET_USAGE_VISIBLE_LIMIT,
): RatedSplit<T> {
  const ranked = items
    .map((item, index) => ({ item, index, score: scoreOf(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const item of ranked) {
    if (keep(item) || visible.length < limit) visible.push(item);
    else hidden.push(item);
  }
  return { visible, hidden };
}

/**
 * Разбор счёта из хранилища машины. Мусор и чужие поля не валят фильтр: счёт — подсказка о
 * порядке кнопок, а не данные, ради которых список должен остаться пустым.
 */
export function sanitizeFacetUsage(raw: unknown): FacetUsage {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return createEmptyFacetUsage();
  const bucketsRaw = (raw as Record<string, unknown>).buckets;
  if (typeof bucketsRaw !== 'object' || bucketsRaw == null || Array.isArray(bucketsRaw)) return createEmptyFacetUsage();
  const buckets: Record<string, Record<string, number>> = {};
  for (const [rawId, daysRaw] of Object.entries(bucketsRaw as Record<string, unknown>)) {
    const id = rawId.trim().slice(0, FACET_USAGE_ID_MAX);
    if (!id || typeof daysRaw !== 'object' || daysRaw == null || Array.isArray(daysRaw)) continue;
    const days: Record<string, number> = {};
    for (const [day, rawCount] of Object.entries(daysRaw as Record<string, unknown>)) {
      if (!USAGE_DAY_RE.test(day)) continue;
      const count = Number(rawCount);
      if (!Number.isFinite(count) || count <= 0) continue;
      days[day] = Math.min(MAX_USAGE_COUNT, Math.trunc(count));
    }
    if (Object.keys(days).length > 0) buckets[id] = days;
  }
  return { buckets };
}
