/**
 * Рейтинг пикеров: кого этот оператор выбирает чаще (план autumn-2026 §D4).
 *
 * Зачем не «последние использованные». Recency отвечает на вопрос «кого я выбирал минуту
 * назад» — и после одного случайного выбора чужой человек стоит первым, вытеснив того, кого
 * оператор ставит в акт каждый день. Частота отвечает на вопрос «кого я выбираю ВООБЩЕ»,
 * а `last` остаётся вторым ключом: при равных счётчиках свежий выбор впереди.
 *
 * Счётчики локальные (у каждого оператора свой набор людей) и хранятся у клиента —
 * это ПОДСКАЗКА ПОРЯДКА, а не данные: потеря хранилища ухудшает сортировку и ничего больше.
 * Поэтому весь разбор здесь защитный: чужой или испорченный JSON обязан дать пустой рейтинг,
 * а не сломать поле выбора.
 *
 * Модуль чистый (без React и localStorage) — привязка живёт в `hooks/usePickerRank.ts`.
 */

/** Один человек в рейтинге: сколько раз выбран и когда в последний раз. */
export type PickerRankEntry = { n: number; last: number };
/** Рейтинг одной ТОЧКИ выбора: `id` → счётчики. */
export type PickerRankScope = Record<string, PickerRankEntry>;
/** Всё хранилище: `rankKey` (точка выбора) → рейтинг. */
export type PickerRankStore = Record<string, PickerRankScope>;

/**
 * Сколько людей помнить на точку выбора. Рейтинг — хвостовая подсказка: человек, выбранный
 * однажды год назад, ничего не подсказывает, а хранилище оператора не резиновое (localStorage
 * общий на всё приложение). Обрезаем по тому же правилу, по которому сортируем.
 */
export const PICKER_RANK_CAP = 24;

function isEntry(v: unknown): v is PickerRankEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as { n?: unknown; last?: unknown };
  return Number.isFinite(Number(e.n)) && Number(e.n) > 0 && Number.isFinite(Number(e.last));
}

/** Разбор хранилища. Всё, что не похоже на рейтинг, молча отбрасывается. */
export function parsePickerRankStore(raw: unknown): PickerRankStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PickerRankStore = {};
  for (const [key, scope] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !scope || typeof scope !== 'object' || Array.isArray(scope)) continue;
    const safe: PickerRankScope = {};
    for (const [id, entry] of Object.entries(scope as Record<string, unknown>)) {
      if (!id || !isEntry(entry)) continue;
      safe[id] = { n: Math.trunc(Number(entry.n)), last: Math.trunc(Number(entry.last)) };
    }
    if (Object.keys(safe).length > 0) out[key] = safe;
  }
  return out;
}

/** Порядок рейтинга: чаще → свежее → по алфавиту. Отдельная функция ради обрезки и сортировки. */
function compareEntries(a: PickerRankEntry, b: PickerRankEntry): number {
  if (a.n !== b.n) return b.n - a.n;
  return b.last - a.last;
}

/**
 * Обрезка хвоста рейтинга по тому же правилу, по которому он сортируется.
 *
 * `protectedId` — тот, кого только что выбрали, и он обязан пережить обрезку. Без этой брони
 * рейтинг ЗАМЕРЗАЛ НАВСЕГДА: когда кэп занят людьми с n≥2, новичок входит с n=1, тут же
 * оказывается слабейшим и вылетает — и так на каждом выборе, сколько его ни выбирай. Новый
 * сотрудник не мог попасть в список никогда, а подсказка тихо переставала подсказывать.
 * С бронёй он вытесняет слабейшего из ОСТАЛЬНЫХ и дальше копит счётчик на общих основаниях.
 */
function capScope(scope: PickerRankScope, protectedId: string): PickerRankScope {
  const ids = Object.keys(scope);
  if (ids.length <= PICKER_RANK_CAP) return scope;
  const kept = ids
    .filter((id) => id !== protectedId)
    .sort((x, y) => compareEntries(scope[x]!, scope[y]!) || x.localeCompare(y))
    .slice(0, PICKER_RANK_CAP - 1);
  const out: PickerRankScope = {};
  for (const id of kept) out[id] = scope[id]!;
  out[protectedId] = scope[protectedId]!;
  return out;
}

/**
 * Отметить выбор. Возвращает НОВОЕ хранилище — вызывающий решает, когда его записать;
 * так два поля на одном экране не затирают счётчики друг друга своей копией состояния.
 */
export function bumpPickerRank(store: PickerRankStore, rankKey: string, id: string, now: number): PickerRankStore {
  const key = String(rankKey ?? '').trim();
  const who = String(id ?? '').trim();
  if (!key || !who) return store;
  const scope = store[key] ?? {};
  const prev = scope[who];
  const next: PickerRankScope = { ...scope, [who]: { n: (prev?.n ?? 0) + 1, last: now } };
  return { ...store, [key]: capScope(next, who) };
}

/**
 * Порядок опций: сперва те, кого оператор выбирает, дальше — ОСТАЛЬНЫЕ В ИСХОДНОМ ПОРЯДКЕ.
 *
 * Хвост намеренно не пересортировывается: порядок списка — решение вызывающего (алфавит,
 * группировка по цеху, уволенные в конце), и рейтинг не вправе его переписывать. Рейтинг
 * только поднимает своих наверх — а это и есть весь смысл: при пустом запросе выпадающий
 * список показывает первые N опций, и нужный человек иначе в эти N не попадал.
 */
export function rankOptionsByPick<T extends { id: string; label?: string }>(
  options: readonly T[],
  scope: PickerRankScope | undefined,
): T[] {
  if (!scope || Object.keys(scope).length === 0) return [...options];
  const ranked: T[] = [];
  const rest: T[] = [];
  for (const option of options) (scope[option.id] ? ranked : rest).push(option);
  if (ranked.length === 0) return [...options];
  ranked.sort((a, b) => {
    const cmp = compareEntries(scope[a.id]!, scope[b.id]!);
    if (cmp !== 0) return cmp;
    return String(a.label ?? '').localeCompare(String(b.label ?? ''), 'ru');
  });
  return [...ranked, ...rest];
}
