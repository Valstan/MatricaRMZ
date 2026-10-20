import {
  engineInternalNumberKey,
  formatEngineInternalNumber,
  normalizeEngineInternalNumber,
  parseEngineInternalNumberInput,
  resolveEngineInternalNumberYear,
} from './engineInternalNumber.js';
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

/**
 * Куда девать номер, который уже есть в базе.
 * - `skip` — ничего не делать; строку оператор пропустил осознанно;
 * - `update` — дописать в существующую карточку то, чего в ней нет (решение владельца
 *   20.10.2026: пачку заводят второй раз уже с внутренними номерами/договором);
 * - `repeat_arrival` — тот же двигатель вернулся, заводим НОВУЮ карточку с флагом.
 */
export type EngineBulkIntakeAction = 'create' | 'skip' | 'repeat_arrival' | 'update';

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
 * Токены списка КАК ЕСТЬ (без схлопывания повторов) — так вставляют колонку из
 * таблицы: оператор копирует столбец внутренних номеров и вставляет его в первую
 * строку превью, значения расходятся по строкам сверху вниз.
 */
export function splitEngineBulkIntakeNumbers(text: string): string[] {
  const out: string[] = [];
  for (const token of String(text ?? '').split(NUMBER_SEPARATORS)) {
    const trimmed = token.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Разбор вставленного текста. Внутренние повторы схлопываются по канон-ключу:
 * «1234», «1234,» и «1234» в другом регистре — один и тот же номер, вторая
 * карточка не нужна.
 */
export function parseEngineBulkIntake(text: string): EngineBulkIntakeParsed {
  const numbers: string[] = [];
  const repeated: string[] = [];
  const seen = new Set<string>();
  for (const number of splitEngineBulkIntakeNumbers(text)) {
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
  engineBrandId: string | null;
  engineBrand: string | null;
  customerId: string | null;
  contractId: string | null;
  /** Внутренний номер как в журнале ('41'), без года. */
  internalNumber: string | null;
  internalNumberYear: number | null;
  /**
   * У двигателя уже есть строка этапа «Разборка/Дефектовка». Дату дефектовки
   * дописываем только туда, где этапа нет: `ensureRepairStageRow` идемпотентен, но
   * оператору надо видеть, что дописывать нечего.
   */
  hasDefectStage: boolean;
};

export type EngineBulkIntakePreviewRow = {
  number: string;
  key: string;
  /** Есть в базе — оператор выбирает «пропустить», «обновить» или «повторный заезд». */
  existing: EngineBulkIntakeExisting | null;
  /** Тот же номер встретился в этом же тексте выше. */
  repeatedInBatch: boolean;
};

export type EngineBulkIntakePreview = {
  rows: EngineBulkIntakePreviewRow[];
  /** Уникальных номеров больше лимита — приём заблокирован, пока список не разделят. */
  overflow: number;
};

/**
 * Что оператор предлагает карточке. Все поля необязательны (решение владельца
 * 20.10.2026): можно принять пачку «только с номерами заказчика» и дозаполнить
 * карточки позже тем же списком.
 */
export type EngineBulkIntakeOffer = {
  brandId: string | null;
  customerId: string | null;
  contractId: string | null;
  arrivalDate: number | null;
  internalNumber: string | null;
  internalNumberYear: number | null;
  /** Дата этапа «Разборка/Дефектовка» — отдельного поля в карточке нет с 01.10.2026. */
  defectDate: number | null;
};

/** Поле карточки, которое приём может дописать. */
export type EngineBulkIntakeField =
  | 'engineBrand'
  | 'customer'
  | 'contract'
  | 'arrivalDate'
  | 'internalNumber'
  | 'defectDate';

export const ENGINE_BULK_INTAKE_FIELD_LABELS: Readonly<Record<EngineBulkIntakeField, string>> = {
  engineBrand: 'марка',
  customer: 'контрагент',
  contract: 'договор',
  arrivalDate: 'дата прихода',
  internalNumber: 'внутренний номер',
  defectDate: 'дата дефектовки',
};

/** «марка, договор» — для строки превью и для итога. */
export function engineBulkIntakeFieldList(fields: readonly EngineBulkIntakeField[]): string {
  return fields.map((field) => ENGINE_BULK_INTAKE_FIELD_LABELS[field]).join(', ');
}

/**
 * Чего в карточке НЕТ из того, что предлагает форма. Именно это дописывает
 * действие «обновить»: заполненное не перезаписываем — в карточке могла быть
 * ручная правка, которой оператор пачки не видел.
 */
export function engineBulkIntakeMissingFields(
  existing: EngineBulkIntakeExisting,
  offer: EngineBulkIntakeOffer,
): EngineBulkIntakeField[] {
  const missing: EngineBulkIntakeField[] = [];
  if (offer.brandId && !existing.engineBrandId) missing.push('engineBrand');
  if (offer.customerId && !existing.customerId) missing.push('customer');
  if (offer.contractId && !existing.contractId) missing.push('contract');
  if (offer.arrivalDate && !existing.arrivalDate) missing.push('arrivalDate');
  if (offer.internalNumber && !existing.internalNumber) missing.push('internalNumber');
  if (offer.defectDate && !existing.hasDefectStage) missing.push('defectDate');
  return missing;
}

/**
 * Где карточка и форма расходятся — там «обновить» промолчит. Оператору это
 * показываем: иначе он решит, что пачка переписала договор, а она его не тронула.
 */
export function engineBulkIntakeConflictingFields(
  existing: EngineBulkIntakeExisting,
  offer: EngineBulkIntakeOffer,
): EngineBulkIntakeField[] {
  const out: EngineBulkIntakeField[] = [];
  if (offer.brandId && existing.engineBrandId && offer.brandId !== existing.engineBrandId) {
    out.push('engineBrand');
  }
  if (offer.customerId && existing.customerId && offer.customerId !== existing.customerId) {
    out.push('customer');
  }
  if (offer.contractId && existing.contractId && offer.contractId !== existing.contractId) {
    out.push('contract');
  }
  const offered = normalizeEngineInternalNumber(offer.internalNumber ?? '');
  const card = normalizeEngineInternalNumber(existing.internalNumber ?? '');
  if (offered && card && offered !== card) out.push('internalNumber');
  return out;
}

/**
 * Внутренний номер из ввода строки. Оператор пишет и короткий «41», и полный
 * «41/26» (как в журнале). Год без подсказки — ТЕКУЩИЙ: номер берут из журнала
 * в момент ввода, а не в момент прихода двигателя (`resolveEngineInternalNumberYear`).
 */
export function readBulkIntakeInternalNumber(
  raw: string,
  nowMs: number,
): { number: string | null; year: number | null } {
  const parsed = parseEngineInternalNumberInput(raw);
  if (!parsed.number) return { number: null, year: null };
  return { number: parsed.number, year: parsed.year ?? resolveEngineInternalNumberYear(nowMs) };
}

/**
 * Пары (номер, год), которые в пачке повторяются. Гейт в main отбил бы вторую
 * строку посреди пачки — оператору честнее увидеть это до нажатия кнопки.
 */
export function engineBulkIntakeInternalNumberDuplicates(
  entries: ReadonlyArray<{ number: string; year: number | null }>,
): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const entry of entries) {
    const key = engineInternalNumberKey(entry.number, entry.year);
    if (!key) continue;
    if (seen.has(key)) repeated.add(formatEngineInternalNumber(entry.number, entry.year));
    seen.add(key);
  }
  return [...repeated];
}

export type EngineBulkIntakeRowInput = {
  number: string;
  action: EngineBulkIntakeAction;
  /** Для «повторного заезда»: карточка прежнего заезда с этим номером. */
  previousEngineId?: string;
  /** Внутренний номер ЭТОГО двигателя ('41' или '41/26') — один на пачку не бывает. */
  internalNumber?: string;
};

/**
 * Что приходит в main. Все общие поля необязательны: пачку можно принять без
 * марки, контрагента, договора и дат — так завели двигатели в первый раз, а
 * второй заход тем же списком их дополнит.
 */
export type EngineBulkIntakeApplyInput = {
  brandId?: string | null;
  customerId?: string | null;
  contractId?: string | null;
  /** Дата прихода одна на весь пакет, мс. */
  arrivalDate?: number | null;
  /** Дата этапа «Разборка/Дефектовка» одна на пакет, мс. */
  defectDate?: number | null;
  rows: EngineBulkIntakeRowInput[];
};

export type EngineBulkIntakeApplyResult =
  | {
      ok: true;
      created: number;
      updated: number;
      skipped: number;
      createdIds: string[];
      /** Дополненные карточки — по ним обновляем список на экране. */
      updatedIds: string[];
      /** Из дополненных: получили договор, значит должны занять место в его плане. */
      contractedIds: string[];
      /** Дата дефектовки была, а этап не встал (нет права, дата раньше прихода). */
      defectStageMissed: number;
      defectStageError: string | null;
    }
  /** Отказ в середине пачки: сколько успело завестись, чтобы окно не потеряло эти карточки. */
  | {
      ok: false;
      error: string;
      created?: number;
      updated?: number;
      createdIds?: string[];
      updatedIds?: string[];
      contractedIds?: string[];
      defectStageMissed?: number;
      defectStageError?: string | null;
    };

/** «Заведём N · дополним M · пропустим K» — одна подпись на кнопку и на итог. */
export function engineBulkIntakeSummary(
  rows: ReadonlyArray<{ action: EngineBulkIntakeAction; existing: EngineBulkIntakeExisting | null }>,
): {
  create: number;
  skip: number;
  repeat: number;
  update: number;
} {
  let create = 0;
  let skip = 0;
  let repeat = 0;
  let update = 0;
  for (const row of rows) {
    if (row.action === 'create' && !row.existing) create += 1;
    else if (row.action === 'repeat_arrival' && row.existing) repeat += 1;
    else if (row.action === 'update' && row.existing) update += 1;
    else skip += 1;
  }
  return { create, skip, repeat, update };
}
