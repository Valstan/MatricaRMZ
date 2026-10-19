// Общее у выгрузок в Office-файлы: имя программы, меры страницы и защита текста от символов,
// на которых Word/Excel объявляют файл повреждённым целиком. Живёт отдельно от сборщиков,
// потому что и списки, и карточки пишут текст в один и тот же XML-мир.

export const APP_NAME = 'Матрица3-РМЗ';

/** Управляющие символы и непарные суррогаты — недопустимы в XML 1.0: на них Excel и Word
 * объявляют файл повреждённым целиком (M80/M81, воспроизведено COM-открытием 2026-08-17). */
// eslint-disable-next-line no-control-regex -- ровно эти символы и запрещаем
const XML_CONTROL_CHARS = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]', 'g');
const XML_LONE_HIGH_SURROGATE = new RegExp('[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])', 'g');
const XML_LONE_LOW_SURROGATE = new RegExp('(^|[^\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]', 'g');

export function xmlSafe(text: string): string {
  return String(text ?? '')
    .replace(XML_CONTROL_CHARS, '')
    .replace(XML_LONE_HIGH_SURROGATE, '')
    .replace(XML_LONE_LOW_SURROGATE, '$1');
}

export const MM_TO_TWIPS = 56.6929;
/** A4 как её считает Word: портрет 11906×16838 твипов, альбом — те же стороны местами. */
export const PAGE_TWIPS = {
  portrait: { width: 11906, height: 16838 },
  landscape: { width: 16838, height: 11906 },
} as const;
/** Поля 12 мм — те же, что у печатного листа (см. планировщик печати). */
export const MARGIN_TWIPS = Math.round(12 * MM_TO_TWIPS);
