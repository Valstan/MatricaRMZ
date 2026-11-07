// Кладовщик (СИЗ), MVP: ядро расчёта норм и сроков выдачи.
// Одно на всех: карточка сотрудника, отчёты и будущий прогноз считают через него,
// иначе «невыданное» в ведомости и «просрочка» в карточке разъедутся (два калькулятора).
import { normalizeLookupCompact, normalizeLookupText } from './lookupNormalize.js';

export const PPE_DAY_MS = 86_400_000;
/** За сколько дней до срока позиция попадает в «скоро выдавать». */
export const PPE_DUE_SOON_DAYS = 14;

export type PpeNormLineInput = {
  normSetId: string;
  nomenclatureId: string;
  qty: number;
  /**
   * Срок носки в месяцах. `null` — срока нет: норма «до износа», «срок определяется
   * документами изготовителя» (приказ Минтруда 767н, Приложение №1) или годовая норма,
   * для которой срок проставляет кладовщик. Такая позиция не попадает в «пора выдавать»:
   * её меняют по износу, а не по календарю.
   */
  wearMonths: number | null;
  /** Вид нормы. `null` — вид неизвестен (старая строка без вида). */
  wearKind?: PpeWearKind | null;
  /** Условия набора- владельца строки (NULL = для всех). Фаза 2: пол/сезон/дежурные. */
  setGender?: string | null;
  setSeason?: string | null;
};

/** Контекст расчёта: пол сотрудника и сезон. Не задан — фильтра по оси нет. */
export type PpeNormCondition = {
  gender?: string | null;
  season?: string | null;
};

export type PpeAbsenceInput = {
  fromMs: number;
  toMs: number;
};

export type PpeIssueEntryInput = {
  nomenclatureId: string;
  qty: number;
  issuedAt: number;
};

export type MergedPpeNorm = {
  nomenclatureId: string;
  qty: number;
  /**
   * Срок носки в месяцах; `null` — срока нет (норма «до износа», «срок определяется
   * документами изготовителя» или годовая норма без проставленного срока). Позиция без
   * срока не бывает «пора выдавать»: её меняют по износу. При слиянии двух строк берётся
   * меньший срок (строже = раньше напомним), а строка без срока уступает строке со сроком.
   */
  wearMonths: number | null;
  /**
   * Вид нормы после слияния. Вид не теряется: «до износа» и «срок определяется
   * документами изготовителя» — разные правила, и оператор должен видеть, по какому
   * живёт позиция. `annual` — годовая норма, срок проставляет кладовщик.
   */
  wearKind: PpeWearKind;
};

export type PpeIssueStatus = 'overdue' | 'dueSoon' | 'ok' | 'neverIssued';

export type PpeNextIssue = MergedPpeNorm & {
  lastIssuedAt: number | null;
  nextDueAt: number | null;
  status: PpeIssueStatus;
};

/** Календарные месяцы по UTC: срок носки «12 мес» = та же дата через год. */
export function addWearMonths(fromMs: number, wearMonths: number): number {
  const d = new Date(fromMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + wearMonths, d.getUTCDate());
}

/**
 * Слияние нескольких норм сотрудника в одну: количества суммируются,
 * при пересечении позиции живёт минимальный срок носки (строже = раньше напомним).
 * Порядок детерминирован (по номенклатуре) — списки не прыгают между прогонами.
 *
 * Фаза 2: второй аргумент (опционален) — фильтр по условиям набора.
 * NULL в норме = подходит всем; незаданная ось контекста не режет ничего.
 * Без второго аргумента поведение ровно как в MVP.
 *
 * Приказ о СИЗ: строка может быть БЕЗ срока («до износа», «срок определяется
 * документами изготовителя»). Такая строка не мешает строке со сроком: если по
 * позиции есть хоть один конечный срок, берётся он (иначе позиция вечно «не пора»).
 * Если срока нет ни у одной строки — срок не задаётся вовсе.
 */
export function resolveEmployeeNorms(lines: PpeNormLineInput[], cond?: PpeNormCondition): MergedPpeNorm[] {
  const gender = cond?.gender ?? null;
  const season = cond?.season ?? null;
  const kept = !cond
    ? lines
    : lines.filter(
      (l) =>
        (l.setGender == null || gender == null || l.setGender === gender) &&
        (l.setSeason == null || season == null || l.setSeason === season),
    );
  const byNom = new Map<string, { qty: number; wearMonths: number | null; wearKind: PpeWearKind }>();
  for (const l of kept) {
    const cur = byNom.get(l.nomenclatureId);
    if (!cur) {
      byNom.set(l.nomenclatureId, {
        qty: l.qty,
        wearMonths: l.wearMonths,
        wearKind: l.wearKind ?? wearKindFor(l.wearMonths),
      });
      continue;
    }
    cur.qty += l.qty;
    const winner = betterWear(
      { kind: cur.wearKind, months: cur.wearMonths },
      { kind: l.wearKind ?? wearKindFor(l.wearMonths), months: l.wearMonths },
    );
    cur.wearKind = winner.kind;
    cur.wearMonths = winner.months;
  }
  return [...byNom.entries()]
    .map(([nomenclatureId, v]) => ({ nomenclatureId, qty: v.qty, wearMonths: v.wearMonths, wearKind: v.wearKind }))
    .sort((a, b) => (a.nomenclatureId < b.nomenclatureId ? -1 : 1));
}

/** Вид по одному лишь сроку — для старых строк, у которых вида не было. */
function wearKindFor(wearMonths: number | null): PpeWearKind {
  return wearMonths == null ? 'until_wearout' : 'months';
}

/**
 * Приоритет вида при слиянии. Больше — важнее.
 * `months` — срок прямо в приказе; `months_clerk` — срок проставил кладовщик;
 * `annual` — годовая норма, срока нет и его должен проставить кладовщик;
 * `until_wearout` / `by_manufacturer` — срока нет вовсе, по ним меняют по износу.
 */
const WEAR_KIND_PRIORITY: Record<PpeWearKind, number> = {
  months: 5,
  months_clerk: 4,
  annual: 3,
  until_wearout: 2,
  by_manufacturer: 1,
};

/**
 * Что побеждает при слиянии: строка со сроком — строку без срока; из двух строк со
 * сроком — меньший срок (строже = раньше напомним), при равенстве — вид важнее.
 */
function betterWear(
  a: { kind: PpeWearKind; months: number | null },
  b: { kind: PpeWearKind; months: number | null },
): { kind: PpeWearKind; months: number | null } {
  if (a.months != null && b.months == null) return a;
  if (b.months != null && a.months == null) return b;
  if (a.months != null && b.months != null && a.months !== b.months) {
    return a.months < b.months ? a : b;
  }
  return WEAR_KIND_PRIORITY[a.kind] >= WEAR_KIND_PRIORITY[b.kind] ? a : b;
}

/**
 * Сдвиг срока на пересечение с отсутствиями (календарные дни, UTC):
 * каждый день отсутствия до срока продлевает носку на день.
 * Пересекающиеся отсутствия считаются по объединению, а не дважды.
 */
export function shiftByAbsences(nextDueAt: number, absences: PpeAbsenceInput[]): number {
  const spans = absences
    .filter((a) => a.fromMs < nextDueAt && a.toMs > a.fromMs)
    .map((a) => [a.fromMs, Math.min(a.toMs, nextDueAt)] as const)
    .sort((x, y) => x[0] - y[0]);
  let shiftMs = 0;
  let coveredUntil = -1;
  for (const [start, end] of spans) {
    if (start >= coveredUntil) {
      shiftMs += end - start;
      coveredUntil = end;
    } else if (end > coveredUntil) {
      shiftMs += end - coveredUntil;
      coveredUntil = end;
    }
  }
  return nextDueAt + Math.round(shiftMs / PPE_DAY_MS) * PPE_DAY_MS;
}

/**
 * Нормы сотрудника = личные привязки + привязки его групп (транзитивно).
 * Дедуп по norm_set_id; конфликт сроков решается позже слиянием
 * (resolveEmployeeNorms берёт минимальный) — и для групповых тоже.
 */
export function resolveGroupNorms(input: {
  personalNormSetIds: string[];
  memberGroupIds: string[];
  groupNorms: Array<{ groupId: string; normSetId: string }>;
}): string[] {
  const out = new Set(input.personalNormSetIds);
  const member = new Set(input.memberGroupIds);
  for (const g of input.groupNorms) {
    if (member.has(g.groupId)) out.add(g.normSetId);
  }
  return [...out].sort();
}

/**
 * Даты следующих выдач: последняя выдача + срок носки. Без выдач — `neverIssued`
 * (срок не тикает из пустоты: норма назначена, но отсчёт идёт от факта).
 * Пятый аргумент (опционален) — отсутствия: срок сдвигается shiftByAbsences.
 *
 * Приказ о СИЗ: норма без срока («до износа», «срок определяется документами
 * изготовителя») даты следующей выдачи не имеет — она не «пора» и не «просрочена».
 * Её меняют по износу, поэтому такая позиция в сроки не попадает вовсе.
 */
export function nextIssueDates(
  merged: MergedPpeNorm[],
  entries: PpeIssueEntryInput[],
  now: number,
  dueSoonDays: number = PPE_DUE_SOON_DAYS,
  absences: PpeAbsenceInput[] = [],
): PpeNextIssue[] {
  const lastByNom = new Map<string, number>();
  for (const e of entries) {
    const cur = lastByNom.get(e.nomenclatureId);
    if (cur == null || e.issuedAt > cur) lastByNom.set(e.nomenclatureId, e.issuedAt);
  }
  return merged.map((m) => {
    const last = lastByNom.get(m.nomenclatureId) ?? null;
    if (last == null) {
      return { ...m, lastIssuedAt: null, nextDueAt: null, status: 'neverIssued' as const };
    }
    if (m.wearMonths == null) {
      // Срока нет — срок не считаем: позиция выдана и живёт до износа.
      return { ...m, lastIssuedAt: last, nextDueAt: null, status: 'ok' as const };
    }
    const rawDueAt = addWearMonths(last, m.wearMonths);
    const nextDueAt = absences.length > 0 ? shiftByAbsences(rawDueAt, absences) : rawDueAt;
    const status: PpeIssueStatus =
      nextDueAt <= now ? 'overdue' : nextDueAt <= now + dueSoonDays * PPE_DAY_MS ? 'dueSoon' : 'ok';
    return { ...m, lastIssuedAt: last, nextDueAt, status };
  });
}

/**
 * «Кому и что выдавать в ближайшие N дней»: просрочка и ближайшие сроки,
 * сортировка по дате (старые первыми). Зародыш заявки и прогноза запасов —
 * те же данные, та же функция, другой горизонт.
 */
export function upcomingIssues(
  merged: MergedPpeNorm[],
  entries: PpeIssueEntryInput[],
  now: number,
  horizonDays: number,
): PpeNextIssue[] {
  const horizon = now + horizonDays * PPE_DAY_MS;
  return nextIssueDates(merged, entries, now)
    .filter((n) => n.nextDueAt != null && n.nextDueAt <= horizon)
    .sort((a, b) => (a.nextDueAt ?? 0) - (b.nextDueAt ?? 0) || (a.nomenclatureId < b.nomenclatureId ? -1 : 1));
}

// ── Нормы приказа о СИЗ (Минтруд 767н, Приложение №1) ─────────────────────────
// Приказ пишет норму словами, и слова эти в документе «съехали»:
// «1пара на 2года», «12 парсрок определяется документами изготовителя».
// Разбор живёт здесь, а не в загрузчике: одна и та же строка встречается
// в приказе, в ручном вводе и в файле ЗУП — и должна читаться одинаково.

/**
 * Как задан срок носки позиции.
 * - `months` — срок прямо в приказе («на 2 года»);
 * - `until_wearout` — «до износа»;
 * - `by_manufacturer` — «срок определяется документами изготовителя»;
 * - `annual` — годовая норма без оговорки («1 шт.», «12 пар»): срока в приказе нет,
 *   его проставляет кладовщик по позиции (решение владельца от 05.11);
 * - `months_clerk` — срок проставил кладовщик.
 *
 * Список — источник истины, а не только тип: контракт синка берёт его отсюда
 * (`z.enum(PPE_WEAR_KINDS)`). Раньше перечисление жило отдельно в DTO, и когда
 * домен добавил `annual` (миграции 0121/0122, 113 позиций приказа), контракт
 * за ним не поспел: строка с `wear_kind='annual'` не проходила валидатор, и ВЕСЬ
 * проход зеркала СИЗ падал на `sync_invalid_row` — 1244 раза в сутки. Список и
 * тип выведены из одного места, чтобы такой разрыв был невозможен.
 */
export const PPE_WEAR_KINDS = [
  'months',
  'until_wearout',
  'by_manufacturer',
  'annual',
  'months_clerk',
] as const;

export type PpeWearKind = (typeof PPE_WEAR_KINDS)[number];

export type PpeOrderNorm = {
  /** Количество на год. */
  qty: number;
  /** Единица измерения: «шт.», «пара», «комплект». */
  unit: string;
  wearKind: PpeWearKind;
  /** Срок в месяцах; `null` при `until_wearout`, `by_manufacturer` и `annual`. */
  wearMonths: number | null;
  /**
   * Оговорка о сроке в терминах приказа: «на 2 года», «до износа»,
   * «срок определяется документами изготовителя». `null` — обычная годовая норма
   * без оговорки («1 шт.», «12 пар»): её печатаем как есть.
   */
  periodText: string | null;
};

/** Единицы измерения приказа — в том виде, как их печатает форма карточки. */
const PPE_UNITS = ['комплект', 'пара', 'пар', 'шт'] as const;

/**
 * Разбор строки нормы приказа: «12 пар», «1 шт. на 2 года», «до износа»,
 * «1 пара срок определяется документами изготовителя».
 *
 * Правила:
 *  - «до износа» → срока нет (позиция живёт до износа);
 *  - «срок определяется документами изготовителя» → срока нет, но вид известен;
 *  - «на N лет/года» → срок N*12 месяцев;
 *  - голое количество → годовая норма («норма выдачи на год»). **Срока из неё не
 *    выводится** (решение владельца от 05.11): «срок носки» и «количество на год» —
 *    разные величины, и выведенный срок молча выдавал себя за приказной. Вид
 *    `annual`: срок не задан, его проставляет кладовщик по позиции.
 *
 * Мусор документа («1пара на 2года», «12 парсрок…») разбирается тем же правилом:
 * числа и слова ищутся независимо, пробелы и точки не важны.
 */
export function parseOrderNormQty(raw: string): PpeOrderNorm {
  const text = String(raw ?? '')
    .replace(/ё/gi, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!text) return { qty: 1, unit: 'шт.', wearKind: 'annual', wearMonths: null, periodText: null };

  // Срок «на N лет/года» — до «до износа»/«определяется…» не дотягиваем.
  // Границу слова задаём НЕ через \b: кириллица в JS не word-символ, и \b после
  // «года» не срабатывает никогда. Вместо этого — «дальше не буква».
  const yearsMatch = text.match(/(\d+)\s*(?:лет|года|год)(?![а-яё])/);
  const explicitMonths = yearsMatch ? Number(yearsMatch[1]) * 12 : null;

  const qtyMatch = text.match(/(\d+)\s*(комплект|пара|пар|шт)/);
  const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
  const unitRaw = qtyMatch?.[2] ?? 'шт';
  const unit = unitRaw === 'пар' ? 'пар' : unitRaw === 'пара' ? 'пара' : unitRaw === 'комплект' ? 'комплект' : 'шт.';

  if (text.includes('до износа')) {
    return { qty, unit, wearKind: 'until_wearout', wearMonths: null, periodText: 'до износа' };
  }
  if (text.includes('определяется документами изготовителя')) {
    return {
      qty,
      unit,
      wearKind: 'by_manufacturer',
      wearMonths: null,
      periodText: 'срок определяется документами изготовителя',
    };
  }
  if (explicitMonths != null) {
    const years = Number(yearsMatch![1]);
    return {
      qty,
      unit,
      wearKind: 'months',
      wearMonths: explicitMonths,
      periodText: `на ${years} ${years === 1 ? 'год' : 'года'}`,
    };
  }
  // Годовая норма без оговорки о сроке: срока в приказе нет — его проставит кладовщик.
  return { qty, unit, wearKind: 'annual', wearMonths: null, periodText: null };
}

/**
 * Срок носки строки — отдельной величиной, с указанием, чей это выбор.
 * «2 мес. (приказ)» / «2 мес. (кладовщик)» / «до износа» /
 * «по документам изготовителя» / «срок не задан».
 *
 * Отдельная величина, а не приписка к количеству: смешивать их в одну строку нельзя,
 * путаница выглядит как «норма не выполнена», хотя не выполнено другое.
 */
export function wearPeriodText(wearKind: PpeWearKind | null, wearMonths: number | null): string {
  if (wearKind === 'until_wearout') return 'до износа';
  if (wearKind === 'by_manufacturer') return 'по документам изготовителя';
  if (wearMonths == null) return 'срок не задан';
  const months = wearMonths % 12 === 0 ? `${wearMonths / 12} г.` : `${wearMonths} мес.`;
  return wearKind === 'months_clerk' ? `${months} (кладовщик)` : `${months} (приказ)`;
}

/**
 * Обратный ход: строка нормы для печати в форме личной карточки (прил. №3) и
 * для колонки «Количество на год». Формулировка повторяет приказ: «1 шт.»,
 * «12 пар», «1 шт. на 2 года», «до износа».
 */
export function formatOrderNormQty(norm: PpeOrderNorm): string {
  if (norm.periodText === 'до износа') return 'до износа';
  const base = `${norm.qty} ${norm.unit}`;
  if (norm.periodText) return `${base} ${norm.periodText}`;
  return base;
}

/** Единицы приказа — для выпадающих списков формы карточки. */
export const PPE_ORDER_UNITS: readonly string[] = PPE_UNITS;

// ── Размеры сотрудника и подсказка позиции при выдаче ───────────────────────
// Фактические размеры живут в EAV-карточке сотрудника (коды те же, что регистрирует
// карточка сотрудника — ensureAttributeDefs). При выдаче кладовщик выбирает позицию
// размерного ряда руками; подсказка — подсветка той позиции, что совпала с его размером.

/** EAV-коды фактических размеров сотрудника (карточка `employee`). */
export const PPE_SIZE_ATTRIBUTE_CODES = {
  clothes: 'ppe_size_clothes',
  shoes: 'ppe_size_shoes',
  height: 'ppe_height',
} as const;

/** Размеры, которые у сотрудника бывают свои (рост — отдельно: он не вид одежды). */
export type PpeSizeKind = 'clothes' | 'shoes';

/**
 * Чей это размер — по названию позиции (в нём обычно и имя модели, и размер:
 * «Костюм зимний, р. 48»). Виды без размерного ряда сотрудника (перчатки, очки,
 * каски) не определяем: подсветка «8» на «р. 48» хуже, чем отсутствие подсказки.
 */
const PPE_SIZE_KIND_KEYWORDS: ReadonlyArray<readonly [RegExp, PpeSizeKind]> = [
  [/сапог|ботинк|полуботинк|туфл|обув|бахил/i, 'shoes'],
  [/костюм|куртк|брюк|комбинезон|полукомбинезон|халат|жилет|фартук|ветровк|плащ|рубашк/i, 'clothes'],
];

export function ppeSizeKindForName(name: string): PpeSizeKind | null {
  const haystack = normalizeLookupText(String(name ?? ''));
  for (const [re, kind] of PPE_SIZE_KIND_KEYWORDS) {
    if (re.test(haystack)) return kind;
  }
  return null;
}

/** Размер — числовая часть введённого («р. 48» → «48»; «XXL» остаётся собой). */
function sizeMatchKey(raw: string): string | null {
  const compact = normalizeLookupCompact(String(raw ?? ''));
  if (!compact) return null;
  return compact.match(/\d+/)?.[0] ?? compact;
}

function sizeWordTokens(name: string): string[] {
  return normalizeLookupText(String(name ?? ''))
    .split(/[^0-9a-zа-яё]+/i)
    .map(normalizeLookupCompact)
    .filter(Boolean);
}

/**
 * Позиция размерного ряда, соответствующая размеру сотрудника: точное совпадение
 * имени, иначе размер целым словом («48» в «Костюм р. 48»). Слово, а не подстрока:
 * «8» не должно совпасть с «р. 48», иначе подсказка соврёт. Несколько совпадений —
 * неоднозначно, молчим; рост, если задан, разводит «размер + рост» у брюк и
 * комбинезонов. Импорт ЗУП живёт своим, более широким правилом (там размер приходит
 * из файла — «р. 42», «42-43» — и не найденная строка обязана быть названа, а не
 * принята за чужую позицию).
 */
export function matchEmployeeSizePosition(args: {
  children: ReadonlyArray<{ id: string; name: string }>;
  size: string;
  height?: string | null;
}): string | null {
  const key = sizeMatchKey(args.size);
  if (!key) return null;
  const exact = args.children.filter((c) => normalizeLookupCompact(c.name) === key);
  if (exact.length === 1) return exact[0]!.id;
  const byWord = args.children.filter((c) => sizeWordTokens(c.name).includes(key));
  if (byWord.length === 1) return byWord[0]!.id;
  if (byWord.length > 1) {
    const heightKey = sizeMatchKey(String(args.height ?? ''));
    if (heightKey) {
      const byHeight = byWord.filter((c) => sizeWordTokens(c.name).includes(heightKey));
      if (byHeight.length === 1) return byHeight[0]!.id;
    }
  }
  return null;
}
