// Подсказки номера двигателя в строке поиска (промт КАРМАНА #155).
//
// Оператор ищет папку с фотографиями двигателя по номеру и набирает обычно
// ПОСЛЕДНИЕ цифры номера («0889» из «Э06АТ0889») — потому что полный номер
// под рукой не всегда. Модуль должен подсказать полный номер из базы, как это
// делает список двигателей, и подставить его в строку по выбору оператора.
//
// Здесь — только чистые правила: что считать «похожим на номер», как из номера
// и запроса понять вид совпадения и в каком порядке выдавать подсказки.
// Обращение к базе — в main (`main/services/engineNumberSuggestionService.ts`).

/**
 * Вид совпадения номера с набранными цифрами — от самого точного к общему.
 *
 * `exact` — набранное равно номеру целиком;
 * `suffix` — номер заканчивается набранным (главный случай: «последние 4 цифры»);
 * `substring` — набранное встречается внутри номера, но не в конце.
 */
export type FileSearchEngineNumberMatchKind = 'exact' | 'suffix' | 'substring';

/** Подсказка двигателя: полный номер и чем он ещё узнаваем. */
export type FileSearchEngineSuggestion = {
  id: string;
  /** Полный номер двигателя — его и подставляем в строку поиска. */
  engineNumber: string;
  /** Внутренний номер («41/26») — если он у двигателя есть. */
  internalNumberFull?: string;
  /** Сквозной номер РМЗ — если сервер его уже выдал. */
  rmzCode?: string;
};

/** Минимум цифр, с которого подсказки имеют смысл: «0889» — да, «088» — рано. */
export const FILE_SEARCH_ENGINE_SUGGEST_MIN_DIGITS = 4;

/** Сколько подсказок показываем по умолчанию (как в глобальном поиске). */
export const FILE_SEARCH_ENGINE_SUGGEST_LIMIT = 12;

/** Потолок подсказок: список читают глазами, больше не нужно. */
export const FILE_SEARCH_ENGINE_SUGGEST_MAX_LIMIT = 20;

/**
 * Разделители, которые оператор вставляет в номер руками: «41/26», «41-26»,
 * «41 26», «41.26».
 */
const SEPARATORS = /[\s\-/._,]/g;

/**
 * Похоже ли на номер: только цифры и разделители, и цифр — не меньше
 * FILE_SEARCH_ENGINE_SUGGEST_MIN_DIGITS.
 *
 * Слово («акт») или смешанный ввод («Э06АТ») подсказками не считаются: они
 * мешали бы искать по содержимому файлов. Это тот же вопрос, что и в глобальном
 * поиске, только строже: там любое слово уже ищется само по себе.
 */
export function isFileSearchEngineNumberLike(raw: string): boolean {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  const digits = text.replace(SEPARATORS, '');
  if (digits.length < FILE_SEARCH_ENGINE_SUGGEST_MIN_DIGITS) return false;
  return /^\d+$/.test(digits);
}

/** Цифры запроса без разделителей — по ним и ищем номер. */
export function fileSearchEngineQueryDigits(raw: string): string {
  return String(raw ?? '').replace(/\D+/g, '');
}

/**
 * Вид совпадения номера с набранными цифрами.
 *
 * Сравнение — буквальное, без «похожести на глаз»: цифры должны быть в номере
 * именно так, как их набрали. Порядок проверок и есть порядок выдачи:
 * точное совпадение, потом хвост, потом вхождение внутрь.
 */
export function fileSearchEngineNumberMatchKind(
  engineNumber: string,
  digits: string,
): FileSearchEngineNumberMatchKind | null {
  const q = String(digits ?? '').trim().toLowerCase();
  if (!q) return null;
  const number = String(engineNumber ?? '').trim().toLowerCase();
  if (!number) return null;
  if (number === q) return 'exact';
  if (number.endsWith(q)) return 'suffix';
  if (number.includes(q)) return 'substring';
  return null;
}

const MATCH_KIND_ORDER: Record<FileSearchEngineNumberMatchKind, number> = {
  exact: 0,
  suffix: 1,
  substring: 2,
};

/**
 * Вся выдача по запросу, без потолка.
 *
 * Нужна отдельно от `rankFileSearchEngineSuggestions`, чтобы честно сказать
 * оператору «показаны первые 20 из 27»: сколько всего нашлось, знает только
 * разбор без обрезки.
 */
export function rankAllFileSearchEngineSuggestions(
  candidates: readonly FileSearchEngineSuggestion[],
  digits: string,
): FileSearchEngineSuggestion[] {
  const q = String(digits ?? '').trim();
  if (!q) return [];
  const scored: { item: FileSearchEngineSuggestion; kind: FileSearchEngineNumberMatchKind }[] = [];
  for (const item of candidates) {
    const kind = fileSearchEngineNumberMatchKind(item.engineNumber, q);
    if (!kind) continue;
    scored.push({ item, kind });
  }
  scored.sort((a, b) => {
    const byKind = MATCH_KIND_ORDER[a.kind] - MATCH_KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    if (a.item.engineNumber !== b.item.engineNumber) {
      return a.item.engineNumber < b.item.engineNumber ? -1 : 1;
    }
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });
  return scored.map((entry) => entry.item);
}

/**
 * Подсказки к запросу: сначала точное совпадение, потом номер, заканчивающийся
 * набранным, потом вхождение внутрь номера. Внутри одного вида — по номеру, по
 * алфавиту: порядок предсказуем и не «прыгает» от запуска к запуску.
 *
 * Лимит — сверху: лишнее оператору не нужно, а база подсказок не должна
 * раздуваться.
 */
export function rankFileSearchEngineSuggestions(
  candidates: readonly FileSearchEngineSuggestion[],
  digits: string,
  limit = FILE_SEARCH_ENGINE_SUGGEST_LIMIT,
): FileSearchEngineSuggestion[] {
  const max = Math.min(Math.max(Number(limit) || 0, 0), FILE_SEARCH_ENGINE_SUGGEST_MAX_LIMIT);
  return rankAllFileSearchEngineSuggestions(candidates, digits).slice(0, max);
}

/**
 * Что показать ПОД списком подсказок (решение владельца 27.11.2026).
 *
 * - `more` — нашлось больше, чем показано, и потолок ещё не достигнут:
 *   кнопка «показать ещё»;
 * - `capped` — дошли до потолка, а совпадений больше: честная заметка
 *   «показаны первые 20 из 27» (как про потолок картинок в папке);
 * - `none` — показывать нечего.
 */
export type FileSearchEngineSuggestFooter =
  | { kind: 'none' }
  | { kind: 'more'; label: string }
  | { kind: 'capped'; label: string };

/**
 * Подвал выпадашки подсказок: кнопка «показать ещё» или заметка о потолке.
 *
 * `total` — сколько совпадений нашлось в базе, `loaded` — сколько пришло в
 * выдачу. Оба числа нужны, чтобы подвал не врёл оператору.
 */
export function fileSearchEngineSuggestFooter(args: {
  total: number;
  loaded: number;
  maxLimit?: number;
}): FileSearchEngineSuggestFooter {
  const max = Math.max(
    1,
    Math.trunc(Number(args.maxLimit ?? FILE_SEARCH_ENGINE_SUGGEST_MAX_LIMIT)) || FILE_SEARCH_ENGINE_SUGGEST_MAX_LIMIT,
  );
  const total = Math.max(0, Math.trunc(Number(args.total ?? 0)) || 0);
  const loaded = Math.max(0, Math.trunc(Number(args.loaded ?? 0)) || 0);
  if (total <= 0 || loaded <= 0) return { kind: 'none' };
  if (loaded < total && loaded < max) {
    return { kind: 'more', label: `Показать ещё ${Math.min(total, max) - loaded}` };
  }
  if (loaded >= max && total > loaded) {
    return { kind: 'capped', label: `Показаны первые ${loaded} из ${total}` };
  }
  return { kind: 'none' };
}
