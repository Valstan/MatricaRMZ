// Сверка «найденное в файлах» ↔ «карточка двигателя» для модуля «Поиск по файлам».
//
// Зачем: оператор приносит файл с движением двигателей и смотрит карточку своего
// двигателя. Без явной пометки непонятно, где данные разошлись, а что можно
// перенести. Названия пунктов при этом разные: в файле «Номер договора», в
// карточке — «Контракт», поэтому сначала ищем совпадение ПО ЗНАЧЕНИЮ, и только
// потом — по названию.

/** Пункт, найденный в файле. */
export type FileSearchFinding = {
  label: string;
  value: string;
};

/** Пункт карточки двигателя. */
export type FileSearchCardField = {
  code: string;
  label: string;
  value: string | null;
};

export type FileSearchComparisonState =
  /** В карточке то же значение — переносить нечего. */
  | 'same'
  /** В карточке другое значение — данные разошлись. */
  | 'different'
  /** В карточке поле пустое — есть что перенести. */
  | 'card_empty'
  /** В карточке нет подходящего пункта. */
  | 'no_match'
  /** Пункт есть только в карточке — в файлах не нашлось. */
  | 'card_only';

export type FileSearchComparisonRow = {
  key: string;
  findingLabel: string | null;
  findingValue: string | null;
  /** Код поля карточки, которому нашлась пара (null — пары нет). */
  cardCode: string | null;
  cardLabel: string | null;
  cardValue: string | null;
  state: FileSearchComparisonState;
  /** По чему нашлось соответствие: по самому значению или по названию пункта. */
  matchedBy: 'value' | 'label' | null;
};

/** Порог похожести названий: ниже — названия считаются разными пунктами. */
export const FILE_SEARCH_LABEL_MATCH_THRESHOLD = 0.82;

/** Минимальная длина значения, с которого разрешаем сравнение «по вхождению». */
const MIN_CONTAINMENT_LENGTH = 4;

/** Дата в карточке лежит миллисекундами, в файле — текстом. Приводим к одному виду. */
function formatLocalDate(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getFullYear()}`;
}

/**
 * Дата из текста — «ДД.ММ.ГГГГ» или «ГГГГ-ММ-ДД».
 *
 * Разбираем части, а не переводим в миллисекунды: так обе стороны сравнения дают
 * один и тот же вид независимо от часового пояса машины.
 */
function parseDateParts(text: string): string | null {
  const direct = text.match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/);
  if (direct) {
    const [, year, month, day] = direct;
    return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
  }
  const ru = text.match(/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/);
  if (ru) {
    const [, day, month, year] = ru;
    return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
  }
  return null;
}

/**
 * Значение к сравнению: регистр, «ё», кавычки и «№» убраны, пробелы схлопнуты,
 * даты приведены к «ДД.ММ.ГГГГ» — той же форме, что видит оператор на экране.
 */
export function normalizeCompareValue(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'boolean') return raw ? 'да' : 'нет';
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 1_000_000_000_000) {
    return formatLocalDate(raw);
  }
  const text = String(raw).trim();
  if (!text) return '';
  const date = parseDateParts(text);
  if (date) return date;
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, '')
    .replace(/№/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Одинаковые ли значения. Короткие строки не сравниваем «по вхождению»: иначе
 * «2» поймает «2026», а «41» — «41/26».
 */
export function compareValuesEqual(a: unknown, b: unknown): boolean {
  const na = normalizeCompareValue(a);
  const nb = normalizeCompareValue(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length < MIN_CONTAINMENT_LENGTH || nb.length < MIN_CONTAINMENT_LENGTH) return false;
  return na.includes(nb) || nb.includes(na);
}

function normalizeLabel(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '')
    .trim();
}

/** Похожесть названий по парам соседних букв (Dice). */
function bigramSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const left = grams.get(gram) ?? 0;
    if (left > 0) {
      hits += 1;
      grams.set(gram, left - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * Похожесть названий пунктов: 1 — совпадают, 0.9 — одно название входит в
 * другое («Марка двигателя» и «Марка двигателя (справочник)»), иначе — по парам
 * букв.
 */
export function labelSimilarity(a: string, b: string): number {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  return bigramSimilarity(na, nb);
}

/**
 * Сверка находок с карточкой.
 *
 * `cardFields` — ВСЕ поля карточки, включая пустые: пустое поле и есть «есть что
 * перенести». В списке «только в карточке» пустые поля не показываются — там
 * интересно то, что в карточке уже заполнено.
 *
 * Порядок важен: сначала по значению (названия в файле и в карточке разные), потом
 * по названию. Каждое поле карточки достаётся первой подходящей находке.
 */
export function compareFindingsWithCard(args: {
  findings: FileSearchFinding[];
  cardFields: FileSearchCardField[];
}): FileSearchComparisonRow[] {
  const findings = args.findings ?? [];
  const cardFields = args.cardFields ?? [];
  const rows: FileSearchComparisonRow[] = [];
  const usedCard = new Set<number>();

  const unmatched: Array<{ index: number; finding: FileSearchFinding }> = [];
  for (const [index, finding] of findings.entries()) {
    let best = -1;
    for (let i = 0; i < cardFields.length; i += 1) {
      if (usedCard.has(i)) continue;
      const field = cardFields[i];
      // По значению совпадает только заполненное поле: пустое не с чем сравнивать.
      if (!field || !field.value) continue;
      if (!compareValuesEqual(finding.value, field.value)) continue;
      best = i;
      break;
    }
    if (best < 0) {
      unmatched.push({ index, finding });
      continue;
    }
    usedCard.add(best);
    const field = cardFields[best];
    if (!field) continue;
    rows.push({
      key: `f${index}`,
      findingLabel: finding.label,
      findingValue: finding.value,
      cardCode: field.code,
      cardLabel: field.label,
      cardValue: field.value,
      state: 'same',
      matchedBy: 'value',
    });
  }

  for (const item of unmatched) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < cardFields.length; i += 1) {
      if (usedCard.has(i)) continue;
      const field = cardFields[i];
      if (!field) continue;
      const score = labelSimilarity(item.finding.label, field.label);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    const field = best >= 0 ? cardFields[best] : undefined;
    if (field && bestScore >= FILE_SEARCH_LABEL_MATCH_THRESHOLD) {
      usedCard.add(best);
      rows.push({
        key: `f${item.index}`,
        findingLabel: item.finding.label,
        findingValue: item.finding.value,
        cardCode: field.code,
        cardLabel: field.label,
        cardValue: field.value,
        state: field.value ? 'different' : 'card_empty',
        matchedBy: 'label',
      });
      continue;
    }
    rows.push({
      key: `f${item.index}`,
      findingLabel: item.finding.label,
      findingValue: item.finding.value,
      cardCode: null,
      cardLabel: null,
      cardValue: null,
      state: 'no_match',
      matchedBy: null,
    });
  }

  cardFields.forEach((field, i) => {
    if (usedCard.has(i)) return;
    // Пустое поле без находки — не «пункт карточки», а пустое место: молчание.
    if (!field.value) return;
    rows.push({
      key: `c${i}`,
      findingLabel: null,
      findingValue: null,
      cardCode: field.code,
      cardLabel: field.label,
      cardValue: field.value,
      state: 'card_only',
      matchedBy: null,
    });
  });

  return rows;
}
