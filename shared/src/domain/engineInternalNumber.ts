/**
 * Внутренний (заводской) номер двигателя — «клеймо», которое набивается на безымянные
 * детали, чтобы деталь всегда находила свой двигатель.
 *
 * Номер выдаёт работник из бумажного журнала дефектовки, и КАЖДЫЙ ГОД нумерация
 * начинается с единицы — сам по себе номер не уникален (41-й есть и в 2026, и в 2027).
 * Поэтому носитель уникальности — пара (номер, год): «непрерывный регистр» поверх
 * годового счётчика. В цеху живёт короткий `41`, в программе — полный `41/26`.
 *
 * Хранение — два EAV-атрибута двигателя (без DDL). Коды с префиксом `engine_`:
 * голый `internal_number` уже занят договорами (`ContractDetailsPage`), и одинаковые
 * коды на разных типах путали бы поиск по коду, хотя в БД они изолированы типом.
 *  - `engine_internal_number`      — текст, как в журнале ('41');
 *  - `engine_internal_number_year` — год присвоения (2026), проставляется из
 *    `arrival_date` при вводе номера и дальше не «плывёт» при правке даты прихода.
 *
 * Когда наряды на разборку начнут выписываться из программы, номер станет
 * присваиваться автоматически — формат и ключ уникальности при этом не меняются.
 */

import { normalizeLookupCompact } from './lookupNormalize.js';

export const ENGINE_INTERNAL_NUMBER_CODE = 'engine_internal_number' as const;
export const ENGINE_INTERNAL_NUMBER_YEAR_CODE = 'engine_internal_number_year' as const;

export type EngineInternalNumber = {
  /** Как ввёл работник ('41') — то, что набито на детали. */
  number: string;
  /** Год присвоения (2026). */
  year: number;
};

const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

/**
 * Канонический вид номера для сравнения: '041' и '41' — один номер журнала, а
 * 'А-041' — другой. Ведущие нули срезаем только у чисто числовых номеров.
 */
export function normalizeEngineInternalNumber(raw: string): string {
  const compact = normalizeLookupCompact(String(raw ?? ''));
  if (!compact) return '';
  return /^\d+$/.test(compact) ? String(Number(compact)) : compact;
}

export function isValidEngineInternalNumberYear(year: unknown): year is number {
  const n = Number(year);
  return Number.isInteger(n) && n >= MIN_YEAR && n <= MAX_YEAR;
}

/**
 * Ключ уникальности пары (номер, год). null — если номера нет или год негоден:
 * без ключа гейт дублей пропускает запись (нечего сравнивать).
 */
export function engineInternalNumberKey(number: string, year: unknown): string | null {
  const normalized = normalizeEngineInternalNumber(number);
  if (!normalized || !isValidEngineInternalNumberYear(year)) return null;
  return `${normalized}:${Number(year)}`;
}

/** Полный номер для показа оператору: '41' + 2026 → '41/26'. */
export function formatEngineInternalNumber(number: string, year: unknown): string {
  const trimmed = String(number ?? '').trim();
  if (!trimmed) return '';
  if (!isValidEngineInternalNumberYear(year)) return trimmed;
  return `${trimmed}/${String(Number(year) % 100).padStart(2, '0')}`;
}

function yearFromTwoDigits(raw: string): number | null {
  if (!/^\d{1,2}$/.test(raw)) return null;
  const year = 2000 + Number(raw);
  return isValidEngineInternalNumberYear(year) ? year : null;
}

/**
 * Tolerant-разбор ввода: оператор может вбить и '41', и полный '41/26' (как записано
 * в журнале). Год из ввода имеет приоритет над авто-подстановкой из даты прихода.
 */
export function parseEngineInternalNumberInput(raw: string): { number: string; year: number | null } {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { number: '', year: null };

  const match = /^(.*?)\s*[/\\]\s*(\d{1,2})$/.exec(trimmed);
  if (match) {
    const year = yearFromTwoDigits(match[2] ?? '');
    const number = String(match[1] ?? '').trim();
    if (year && number) return { number, year };
  }
  return { number: trimmed, year: null };
}

/**
 * Год присвоения — ТЕКУЩИЙ (решение владельца 2026-07-15): номер берётся из журнала
 * в момент ввода, значит и год журнала — сегодняшний. Дата прихода тут ни при чём —
 * двигатель мог приехать в декабре, а номер получить в январе. Поле года остаётся
 * редактируемым: задним числом правится руками.
 */
export function resolveEngineInternalNumberYear(nowMs: number): number {
  return new Date(nowMs).getFullYear();
}

/**
 * Ключ сортировки «по годам, внутри года по возрастанию номера». Числовая часть
 * дополняется нулями, иначе строковое сравнение ставит '41' раньше '7'.
 * Пустой номер даёт '' — такие строки уезжают в конец списка.
 */
export function engineInternalNumberSortKey(number: string, year: unknown): string {
  const normalized = normalizeEngineInternalNumber(number);
  if (!normalized) return '';
  const yearPart = isValidEngineInternalNumberYear(year) ? String(Number(year)) : '0000';
  const numberPart = /^\d+$/.test(normalized) ? normalized.padStart(12, '0') : normalized;
  return `${yearPart}:${numberPart}`;
}

/**
 * Ключ сортировки из готового полного номера ('41/26'). Нужен там, где хранится только
 * снимок-строка (наряды, отчёты): без разбора обратно на пару '41/26' свернулось бы в
 * число 4126 и годы перемешались бы с номерами.
 */
export function engineInternalNumberSortKeyFromFull(full: string): string {
  const parsed = parseEngineInternalNumberInput(full);
  return engineInternalNumberSortKey(parsed.number, parsed.year);
}

/**
 * Отказ при попытке занять чужую пару (номер, год). Текст общий для клиентского и
 * серверного гейта — оператор видит одно и то же, откуда бы запись ни пришла.
 */
export function engineInternalNumberDuplicateMessage(dup: {
  internalNumber: string;
  internalNumberYear: number;
  engineNumber?: string;
  engineBrand?: string;
}): string {
  const full = formatEngineInternalNumber(dup.internalNumber, dup.internalNumberYear);
  const owner = [dup.engineBrand, dup.engineNumber].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
  const ownerPart = owner ? ` Его занял двигатель: ${owner}.` : '';
  return `Внутренний номер «${full}» уже занят.${ownerPart} Проверьте номер в журнале дефектовки.`;
}

/**
 * Совпадает ли двигатель с поисковым запросом по внутреннему номеру.
 * Оператор ищет и коротким '41' (тогда попадают все 41-е по годам), и точным '41/26'.
 */
export function matchesEngineInternalNumber(query: string, number: string, year: unknown): boolean {
  const parsed = parseEngineInternalNumberInput(query);
  const queryNumber = normalizeEngineInternalNumber(parsed.number);
  if (!queryNumber) return false;

  const targetNumber = normalizeEngineInternalNumber(number);
  if (!targetNumber || targetNumber !== queryNumber) return false;
  if (parsed.year == null) return true;
  return isValidEngineInternalNumberYear(year) && Number(year) === parsed.year;
}
