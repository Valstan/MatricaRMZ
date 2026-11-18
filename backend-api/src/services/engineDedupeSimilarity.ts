/**
 * «Сильно похожие» двигатели — расчёт пар (владелец 18.11.2026).
 *
 * ПРЕДЫСТОРИЯ. Разбор дублей двигателей склеивал номера кластером по расстоянию
 * правок (union-find по транзитивной близости). На живых данных это давало группы
 * по 1478 двигателей: номера завода идут подряд («Т12АТ9059», «Т12АТ9329», …),
 * и любые соседние номера «близки» на две правки. Оператору такая группа ничего
 * не даёт, а склейка такой группы — вред: это РАЗНЫЕ двигатели одного заказчика.
 *
 * ПРАВИЛО. Два двигателя — сильно похожие, если:
 *   1. номера принадлежат одной серийной семье: серийный хвост (цифры в конце)
 *      совпадает (перепутали букву) либо отличается на 1–2 (ошибка в цифре или
 *      перестановка двух цифр). Соседние по номеру РАЗНЫЕ двигатели этим
 *      отсекаются: их хвосты различаются на десятки;
 *   2. карточки совпадают по «ядру личности» — марка, заказчик, дата прихода:
 *      поле считается совпавшим, если у обоих оно заполнено и одинаково;
 *      совпасть должны минимум ДВА поля из трёх (одного совпадения мало: у
 *      завода сотни двигателей одной марки и одного заказчика);
 *   3. дата прихода заполнена и совпадает у обоих — это «тот же самый приход
 *      на завод», без него соседние номера одного заказчика неразличимы;
 *   4. различающихся полей не больше двух — «номер» плюс, максимум, одно
 *      другое. Это ровно «заполнено по-разному, с ошибками».
 *
 * Пары, а не кластеры: каждый двигатель попадает максимум в одну пару, поэтому
 * список остаётся списком ПАР, а слипанием в одну карточку ничего не теряется.
 */
import { damerauLevenshtein, normalizeLookupCompact } from '@matricarmz/shared';

/** Режим разбора дублей: только по совпадению номера или «сильно похожие». */
export type EngineDedupeMode = 'exact' | 'similar';

/** Поля карточки двигателя, по которым смотрят расхождения. */
export const ENGINE_DEDUPE_FIELDS = ['марка', 'заказчик', 'дата прихода', 'номер'] as const;

/** «Ядро личности»: поля, по которым двигатель узнаётся как тот же самый. */
export const ENGINE_DEDUPE_CORE_FIELDS = ['марка', 'заказчик', 'дата прихода'] as const;

export type EngineDedupeField = (typeof ENGINE_DEDUPE_FIELDS)[number];

export type EngineSimilarityInput = {
  id: string;
  /** Номер двигателя как в карточке. */
  engineNumber: string;
  /** Марка двигателя (пусто — не заполнена). */
  engineBrand: string;
  /** Заказчик (id), пусто — не заполнен. */
  customerId: string;
  /** Дата прихода (миллисекунды как строка), пусто — не заполнена. */
  arrivalDate: string;
};

export type EngineSimilarityPair = {
  a: EngineSimilarityInput;
  b: EngineSimilarityInput;
  /** Расстояние между номерами: 1 — одна правка, 2 — две. */
  numberDistance: number;
  /** Какие поля карточек различаются. */
  diffFields: EngineDedupeField[];
};

/** Потолок пар в выдаче: список должен читаться глазами, а не листаться. */
export const ENGINE_SIMILAR_PAIR_LIMIT = 50;

/** Сколько полей ядра должны совпасть, чтобы пара считалась «тем же двигателем». */
export const ENGINE_SIMILAR_MIN_CORE_MATCH = 2;

/**
 * Обязательное совпадение ядра: дата прихода. Без неё соседние номера одного
 * заказчика с одной маркой неразличимы — у завода сотни таких двигателей, и
 * «похожими» станет всё подряд.
 */
export const ENGINE_SIMILAR_REQUIRED_CORE_FIELD: (typeof ENGINE_DEDUPE_CORE_FIELDS)[number] = 'дата прихода';

/** Сколько полей могут различаться (включая номер). */
export const ENGINE_SIMILAR_MAX_DIFF_FIELDS = 2;

/** Бюджет правок номера: короткий номер — одна правка, длинный — две. */
export function editBudgetForKey(len: number): number {
  return len < 4 ? 0 : len <= 7 ? 1 : 2;
}

/** Серийный хвост номера: цифры в конце («Т12АТ9069» → «9069»). */
export function serialTail(value: string): string {
  const m = /(\d+)\s*$/.exec(String(value ?? ''));
  return m?.[1] ?? '';
}

/**
 * Одна серийная семья: хвост совпал (перепутали букву) или отличается на 1–2
 * (ошибка в цифре, перестановка двух цифр). Соседние номера РАЗНЫХ двигателей
 * сюда не попадают — их хвосты различаются на десятки.
 */
export function isSameSerialFamily(a: string, b: string): boolean {
  const ta = serialTail(a);
  const tb = serialTail(b);
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  if (Math.abs(Number(ta) - Number(tb)) <= 2) return true;
  return ta.length === tb.length && [...ta].sort().join('') === [...tb].sort().join('');
}

/** Поле считается совпавшим, если у обоих оно заполнено и значения равны. */
function coreValue(engine: EngineSimilarityInput, field: (typeof ENGINE_DEDUPE_CORE_FIELDS)[number]): string {
  if (field === 'марка') return engine.engineBrand.trim();
  if (field === 'заказчик') return engine.customerId.trim();
  return engine.arrivalDate.trim();
}

/** Поля, по которым карточки различаются. */
export function diffFieldsOf(a: EngineSimilarityInput, b: EngineSimilarityInput): EngineDedupeField[] {
  const diff: EngineDedupeField[] = [];
  for (const field of ENGINE_DEDUPE_CORE_FIELDS) {
    if (coreValue(a, field) !== coreValue(b, field)) diff.push(field);
  }
  if (a.engineNumber.trim() !== b.engineNumber.trim()) diff.push('номер');
  return diff;
}

/** Сколько полей ядра совпало (оба заполнены и равны). */
export function coreMatchesOf(a: EngineSimilarityInput, b: EngineSimilarityInput): number {
  let n = 0;
  for (const field of ENGINE_DEDUPE_CORE_FIELDS) {
    const va = coreValue(a, field);
    const vb = coreValue(b, field);
    if (va && vb && va === vb) n += 1;
  }
  return n;
}

/** Пара — «сильно похожая»? */
export function isStronglySimilar(a: EngineSimilarityInput, b: EngineSimilarityInput): boolean {
  if (a.id === b.id) return false;
  if (!isSameSerialFamily(a.engineNumber, b.engineNumber)) return false;
  if (coreMatchesOf(a, b) < ENGINE_SIMILAR_MIN_CORE_MATCH) return false;
  // Дата прихода обязана совпасть: без неё соседние номера одного заказчика
  // неразличимы (у завода сотни двигателей одной марки и одного заказчика).
  const required = coreValue(a, ENGINE_SIMILAR_REQUIRED_CORE_FIELD);
  if (!required || required !== coreValue(b, ENGINE_SIMILAR_REQUIRED_CORE_FIELD)) return false;
  return diffFieldsOf(a, b).length <= ENGINE_SIMILAR_MAX_DIFF_FIELDS;
}

export type EngineSimilarityResult = {
  pairs: EngineSimilarityPair[];
  /** Пар всего найдено (может быть больше, чем в `pairs` — сработал потолок). */
  totalPairs: number;
  /** Список обрезан по потолку. */
  truncated: boolean;
};

/**
 * Найти пары сильно похожих двигателей.
 *
 * Кандидаты берутся bucketing'ом по длине номера (±бюджет правок), чтобы не
 * сравнивать все пары подряд; каждый кандидат проверяется полным правилом.
 * Двигатель попадает максимум в одну пару (сильнейшую), поэтому в списке нет
 * ни «звезды», ни цепочек.
 */
export function findSimilarEnginePairs(
  engines: readonly EngineSimilarityInput[],
  opts?: { limit?: number },
): EngineSimilarityResult {
  const limit = opts?.limit ?? ENGINE_SIMILAR_PAIR_LIMIT;
  const byKey = new Map<string, EngineSimilarityInput[]>();
  for (const e of engines) {
    const key = normalizeLookupCompact(e.engineNumber ?? '');
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(e);
    else byKey.set(key, [e]);
  }
  const keys = [...byKey.keys()];
  const byLen = new Map<number, string[]>();
  for (const k of keys) {
    const bucket = byLen.get(k.length);
    if (bucket) bucket.push(k);
    else byLen.set(k.length, [k]);
  }

  const found: EngineSimilarityPair[] = [];
  const seen = new Set<string>();
  let comparisons = 8_000_000; // потолок сравнений — ограничение CPU на больших базах
  let truncatedScan = false;
  for (const k of keys) {
    const budget = editBudgetForKey(k.length);
    if (!budget) continue;
    const candidates: string[] = [];
    for (let l = k.length - budget; l <= k.length + budget; l += 1) {
      const bucket = byLen.get(l);
      if (bucket) candidates.push(...bucket);
    }
    for (const o of candidates) {
      if (o === k) continue;
      if (comparisons-- <= 0) {
        truncatedScan = true;
        break;
      }
      const distance = damerauLevenshtein(k, o, budget);
      if (distance <= 0 || distance > budget) continue;
      for (const a of byKey.get(k) ?? []) {
        for (const b of byKey.get(o) ?? []) {
          const id = [a.id, b.id].sort().join('|');
          if (seen.has(id)) continue;
          seen.add(id);
          if (!isStronglySimilar(a, b)) continue;
          found.push({ a, b, numberDistance: distance, diffFields: diffFieldsOf(a, b) });
        }
      }
    }
    if (truncatedScan) break;
  }

  // Сильнейшие пары первыми: меньше правок в номере — меньше различий.
  found.sort((x, y) => x.numberDistance - y.numberDistance || x.diffFields.length - y.diffFields.length);

  // Каждый двигатель — максимум в одной паре: список остаётся списком пар.
  const used = new Set<string>();
  const pairs: EngineSimilarityPair[] = [];
  for (const pair of found) {
    if (used.has(pair.a.id) || used.has(pair.b.id)) continue;
    used.add(pair.a.id);
    used.add(pair.b.id);
    pairs.push(pair);
  }
  const totalPairs = pairs.length;
  const truncated = truncatedScan || totalPairs > limit;
  return { pairs: pairs.slice(0, limit), totalPairs, truncated };
}
