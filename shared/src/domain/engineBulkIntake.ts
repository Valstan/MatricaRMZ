import { normalizeLookupCompact } from './lookupNormalize.js';

/**
 * Пакетный приём двигателей списком (накладная): оператор вставляет номера из
 * документа, а программа заводит по карточке на каждый.
 *
 * Разделитель — пробел, таб, запятая, точка с запятой, перевод строки (CR/LF).
 * Косая черта разделителем НЕ является: она встречается в номерах (внутренний
 * «41/26», заводские с дробью) — если резать по ней, один двигатель превратится
 * в два несуществующих.
 */
const NUMBER_SEPARATORS = /[\s,;]+/u;

/** Сколько номеров принимаем за один заход. Документ на 500+ позиций — это ошибка ввода, а не накладная. */
export const ENGINE_BULK_INTAKE_MAX = 500;

/** Куда девать номер, который уже есть в базе. */
export type EngineBulkIntakeAction = 'create' | 'skip' | 'repeat_arrival';

/** Канон-ключ номера: тот же, по которому карточка и сервер ловят дубли. */
export function engineBulkIntakeKey(engineNumber: string): string {
  return normalizeLookupCompact(String(engineNumber ?? ''));
}

export type EngineBulkIntakeParsed = {
  /** Уникальные номера в порядке ввода (в том виде, как их ввёл оператор). */
  numbers: string[];
  /** Номера, которые встретились в тексте повторно (как ввёл оператор). */
  repeated: string[];
};

/**
 * Разбор вставленного текста. Внутренние повторы схлопываются по канон-ключу:
 * «1234», «1234,» и «1234» в другом регистре — один и тот же номер, вторая
 * карточка не нужна.
 */
export function parseEngineBulkIntake(text: string): EngineBulkIntakeParsed {
  const numbers: string[] = [];
  const repeated: string[] = [];
  const seen = new Set<string>();
  for (const token of String(text ?? '').split(NUMBER_SEPARATORS)) {
    const number = token.trim();
    if (!number) continue;
    const key = engineBulkIntakeKey(number);
    if (!key) continue;
    if (seen.has(key)) {
      if (!repeated.some((n) => engineBulkIntakeKey(n) === key)) repeated.push(number);
      continue;
    }
    seen.add(key);
    numbers.push(number);
  }
  return { numbers, repeated };
}

/** Двигатель с этим номером, уже лежащий в базе (для превью и решения по дублю). */
export type EngineBulkIntakeExisting = {
  id: string;
  engineNumber: string;
  arrivalDate: number | null;
  engineBrand: string | null;
  customerId: string | null;
  contractId: string | null;
};

export type EngineBulkIntakePreviewRow = {
  number: string;
  key: string;
  /** Есть в базе — оператор выбирает «пропустить» или «повторный заезд». */
  existing: EngineBulkIntakeExisting | null;
  /** Тот же номер встретился в этом же тексте выше. */
  repeatedInBatch: boolean;
};

export type EngineBulkIntakePreview = {
  rows: EngineBulkIntakePreviewRow[];
  /** Уникальных номеров больше лимита — приём заблокирован, пока список не разделят. */
  overflow: number;
};

export type EngineBulkIntakeRowInput = {
  number: string;
  action: EngineBulkIntakeAction;
  /** Для «повторного заезда»: карточка прежнего заезда с этим номером. */
  previousEngineId?: string;
};

export type EngineBulkIntakeApplyInput = {
  brandId: string;
  customerId: string;
  contractId: string;
  /** Дата прихода одна на весь пакет, мс. */
  arrivalDate: number;
  rows: EngineBulkIntakeRowInput[];
};

export type EngineBulkIntakeApplyResult =
  | { ok: true; created: number; skipped: number; createdIds: string[] }
  /** Отказ в середине пачки: сколько успело завестись, чтобы окно не потеряло эти карточки. */
  | { ok: false; error: string; created?: number; createdIds?: string[] };

/** «Будет создано N · пропущено M» — одна подпись на кнопку и на итог. */
export function engineBulkIntakeSummary(rows: ReadonlyArray<{ action: EngineBulkIntakeAction; existing: EngineBulkIntakeExisting | null }>): {
  create: number;
  skip: number;
  repeat: number;
} {
  let create = 0;
  let skip = 0;
  let repeat = 0;
  for (const row of rows) {
    if (row.action === 'create' && !row.existing) create += 1;
    else if (row.action === 'repeat_arrival' && row.existing) repeat += 1;
    else skip += 1;
  }
  return { create, skip, repeat };
}
