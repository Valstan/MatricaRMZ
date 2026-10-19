/**
 * Выгрузка списка в Excel/Word — общий контракт рендерера и main-процесса.
 *
 * Рендерер владеет данными (колонки, строки, отбор) и отдаёт их уже текстом — тем же,
 * что печатается (`printValue`), — а тип ячейки называет отдельно. Разбирать «1 234,56»
 * и «19.10.2026» в числа и даты должен тот, кто собирает файл: Word и Excel получают
 * настоящие числа и даты, а не строки, по которым не считаются суммы и не работают
 * фильтры. Обратно в текст ячейка падает только там, где разобрать не удалось.
 */

export type ListExportFormat = 'xlsx' | 'docx';

export type ListExportCellKind = 'text' | 'number' | 'date';

export type ListExportColumn = {
  label: string;
  kind: ListExportCellKind;
};

export type ListExportSpec = {
  /** Название таблицы — то же, что в шапке печати. */
  title: string;
  /** Строки отбора человеческим языком (`describeFacetSelection`) — шапка файла. */
  filters: string[];
  /** «Выгружено 19.10.2026 05:12 · Иванов И. И.» */
  meta?: string;
  columns: ListExportColumn[];
  /** Ячейки текстом, как их видит оператор. Тип берётся из `columns[].kind`. */
  rows: string[][];
  /**
   * Ширины колонок в мм из планировщика печати (`planListPrintLayout`): Word получает ту же
   * раскладку, что печатный лист. Нет ширин — сборщик разложит таблицу сам.
   */
  columnWidthsMm?: number[];
  /** Имя файла без расширения. */
  fileBaseName: string;
};

/**
 * Даты приходят из списков то без времени, то с ним. Время локаль пишет через запятую и нередко
 * с секундами («19.10.2026, 01:26:16» — форма, которую даёт сама программа), поэтому запятая
 * и секунды в разборе допустимы: без них такая дата осталась бы текстом.
 */
const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})(?:,?\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Подписи колонок, которые считают, а не читают. Нужны только для целых чисел: «12» —
 * это и количество, и код, различить их по значению нельзя. Дробное или разряженное
 * число («12,5», «1 234,56») выдаёт себя само и подписи не требует.
 */
const COUNTING_LABEL_RE =
  /(сумма|стоимость|цена|количеств|кол-во|остаток|вес|масса|ставка|тариф|итого|ндс|н\.д\.с|процент|начислен|удержан|оклад|заработ|оплата)/i;

/** Прочерк вместо значения — пустое место, а не текст: на нём тип колонки не строится. */
const PLACEHOLDER_RE = /^[—–-]$/;

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
/** Группировка разрядов пробелом или неразрывным пробелом, дробная часть — запятой. */
const FORMATTED_NUMBER_HINT_RE = /[\u0020\u00A0\u202F]\d{3}\b|,/;

export function parseExportNumber(text: string): number | null {
  const cleaned = String(text ?? '')
    .replace(/[\s\u00A0\u202F]/g, '')
    .replace(',', '.');
  if (!NUMBER_RE.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Дата из «19.10.2026» / «19.10.2026 14:30» / «19.10.2026, 14:30:15». Время — UTC: часовой пояс машины файл не касается. */
export function parseExportDate(text: string): { date: Date; hasTime: boolean } | null {
  const m = DATE_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const date = new Date(
    Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh ?? '0'), Number(mi ?? '0'), Number(ss ?? '0')),
  );
  if (date.getUTCDate() !== Number(dd) || date.getUTCMonth() !== Number(mm) - 1) return null;
  return { date, hasTime: hh !== undefined };
}

/**
 * Тип колонки по её значениям. Даты распознаются по форме — другой трактовки у «19.10.2026»
 * нет. С числами осторожнее: колонка становится числовой, только если дробный/разряженный
 * вид говорит об этом сам или её подпись называет считаемое (иначе артикул «007» потерял бы
 * нули, а телефон превратился бы в экспоненту).
 */
export function inferListExportKind(label: string, values: readonly string[]): ListExportCellKind {
  const filled = values.map((v) => String(v ?? '').trim()).filter((v) => v !== '' && !PLACEHOLDER_RE.test(v));
  if (filled.length === 0) return 'text';

  const dates = filled.filter((v) => parseExportDate(v) !== null).length;
  if (dates / filled.length >= 0.8) return 'date';

  const numbers = filled.filter((v) => parseExportNumber(v) !== null).length;
  if (numbers / filled.length >= 0.8) {
    const formatted = filled.some((v) => FORMATTED_NUMBER_HINT_RE.test(v));
    if (formatted || COUNTING_LABEL_RE.test(label)) return 'number';
  }

  return 'text';
}

/** Имя файла для Windows: запрещённые знаки, хвостовые точки и пробелы, потолок длины. */
export function sanitizeExportFileName(name: string): string {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'Список';
}
