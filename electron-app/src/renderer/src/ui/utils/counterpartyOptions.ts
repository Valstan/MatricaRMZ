import { mapEntityRowsToSearchOptions, type SearchableSelectOption } from './selectOptions.js';

/**
 * ОДИН источник контрагентов для поля выбора и для списка (промт КАРМАНА #146).
 *
 * Что было: поле «Контрагент» в карточке договора читало ТОЛЬКО легаси-EAV
 * (`admin.entities.listByEntityType`), а список контрагентов — строгую таблицу
 * `erp_counterparties` ПЛЮС EAV с мержем. Два экрана читали разное, и это было видно
 * глазами: в списке контрагент есть, его можно выбрать и отредактировать, а в подсказках
 * поля его нет — «новые не видны».
 *
 * Почему подсказки отставали: у контрагента, заведённого через строгую таблицу, его
 * значения-атрибуты (название, ИНН, КПП, адрес) доезжают до сервера, но НЕ попадают в
 * журнал изменений ⇒ pull их клиентам не привозит ⇒ в локальной реплике у контрагента
 * нет подписи ⇒ поле выбора видит только короткий id и не находит его по названию.
 * (На сервере на 25.11.2026 таких строк было 2 228 из 54 944 — дырка общая, не только
 * про контрагентов; см. PENDING.)
 *
 * Правило: **поле выбора и список читают одно и то же.** Мерж строгих строк и EAV живёт
 * здесь — второго места для него быть не должно.
 */

/** Строка строгой таблицы `erp_counterparties` в том виде, что её отдаёт IPC. */
export type CounterpartyStrictRow = {
  id: string;
  name?: string | null;
  short_name?: string | null;
  inn?: string | null;
  kpp?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  engine_kind?: string | null;
  updated_at?: number | null;
  /** В EAV-строках время живёт в camelCase — держим оба имени, чтобы мёрж не ломал чтение. */
  updatedAt?: number | null;
  /** Эти два поля есть только у EAV-строк; в мёрже тип общий — список их читает. */
  displayName?: string | null;
  searchText?: string | null;
};

/** Строка EAV в том виде, что её отдаёт `admin.entities.listByEntityType`. */
export type CounterpartyEavRow = {
  id: string;
  displayName?: string | null;
  searchText?: string | null;
  updatedAt?: number | null;
  /** У строк строгой таблицы время в snake_case — держим оба имени. */
  updated_at?: number | null;
};

export type CounterpartySources = {
  /** Строки строгой таблицы (карточка контрагента — она же источник для списка). */
  strictRows: CounterpartyStrictRow[];
  /** Легаси-EAV: запасной путь и источник вложений. */
  eavRows: CounterpartyEavRow[];
  /** Атрибуты EAV по id сущности — нужны списку для превью и полей. */
  attrsById: Map<string, Record<string, unknown>>;
  /** Строгие строки по id — по ним опознаётся, что запись уже из строгой таблицы. */
  strictById: Map<string, CounterpartyStrictRow>;
  /** Мерж: строгие строки + EAV-строки, которых среди строгих ещё нет. */
  merged: Array<CounterpartyStrictRow | CounterpartyEavRow>;
};

/**
 * Мерж строгой таблицы и EAV — единственное место, где они соединяются.
 *
 * Строгие строки идут первыми: карточка контрагента — источник правды (так же, как в
 * списке), а EAV-добавленные не теряются (на клиентах без реплики строгой таблицы
 * список остаётся рабочим).
 */
export function mergeCounterpartyRows(
  strictRows: CounterpartyStrictRow[],
  eavRows: CounterpartyEavRow[],
): { strictById: Map<string, CounterpartyStrictRow>; merged: Array<CounterpartyStrictRow | CounterpartyEavRow> } {
  const strictById = new Map<string, CounterpartyStrictRow>();
  for (const row of strictRows) strictById.set(String(row.id), row);
  const rest = eavRows.filter((row) => !strictById.has(String(row.id)));
  return { strictById, merged: strictRows.length > 0 ? [...strictRows, ...rest] : [...eavRows] };
}

/** Подпись контрагента для поля выбора: название из строгой таблицы, иначе — из EAV. */
export function counterpartyLabel(row: CounterpartyStrictRow | CounterpartyEavRow, strictById: Map<string, CounterpartyStrictRow>): string {
  const strict = strictById.get(String(row.id));
  if (strict) {
    const name = String(strict.name ?? '').trim();
    if (name) return name;
  }
  const eavName = String((row as CounterpartyEavRow).displayName ?? '').trim();
  if (eavName) return eavName;
  return String(row.id ?? '');
}

/** Поисковый текст: всё, по чему контрагента можно найти (название, ИНН, КПП, адрес…). */
export function counterpartySearchText(
  row: CounterpartyStrictRow | CounterpartyEavRow,
  strictById: Map<string, CounterpartyStrictRow>,
): string {
  const parts: Array<string | null | undefined> = [];
  const strict = strictById.get(String(row.id));
  if (strict) {
    parts.push(strict.name, strict.short_name, strict.inn, strict.kpp, strict.address, strict.phone, strict.email);
  }
  parts.push((row as CounterpartyEavRow).searchText);
  return parts.map((p) => (p == null ? '' : String(p))).filter(Boolean).join(' ').trim();
}

/**
 * Подсказки поля выбора контрагента — из ТОГО ЖЕ мержа, что и список.
 *
 * Метка и поисковый текст считаются здесь, чтобы поле выбора и список не разошлись
 * снова: у контрагента из строгой таблицы название есть, даже если его значения-атрибуты
 * ещё не доехали до реплики.
 */
export function counterpartySearchOptions(sources: CounterpartySources): SearchableSelectOption[] {
  return sources.merged.map((row) => {
    const label = counterpartyLabel(row, sources.strictById);
    const searchText = counterpartySearchText(row, sources.strictById);
    return {
      id: String(row.id),
      label,
      ...(searchText ? { searchText } : {}),
    };
  });
}

/**
 * Загрузить подсказки контрагентов для поля выбора.
 *
 * Источники те же, что у списка контрагентов: строгая таблица (реплика на машине) плюс
 * легаси-EAV. Если строгой таблицы на клиенте нет — берём EAV (запасной путь).
 */
export async function loadCounterpartySearchOptions(typeId: string): Promise<SearchableSelectOption[]> {
  const sources = await loadCounterpartySources(typeId);
  return counterpartySearchOptions(sources);
}

/** Загрузить оба источника и смержить их — для списка и для поля выбора. */
export async function loadCounterpartySources(typeId: string): Promise<CounterpartySources> {
  const strictResult = await window.matrica.contracts.counterparty.list().catch(() => null);
  const strictRows: CounterpartyStrictRow[] =
    strictResult && strictResult.ok && Array.isArray(strictResult.rows) ? (strictResult.rows as CounterpartyStrictRow[]) : [];
  const eavRows = (await window.matrica.admin.entities.listByEntityType(typeId).catch(() => [])) as CounterpartyEavRow[];
  const withAttrs = await window.matrica.admin.entities.listByEntityTypeWithAttrs(typeId).catch(() => []);
  const attrsById = new Map<string, Record<string, unknown>>(
    (Array.isArray(withAttrs) ? withAttrs : []).map((row) => [String(row.id), (row.attributes ?? {}) as Record<string, unknown>]),
  );
  const { strictById, merged } = mergeCounterpartyRows(strictRows, eavRows);
  return { strictRows, eavRows: Array.isArray(eavRows) ? eavRows : [], attrsById, strictById: strictById, merged };
}

/** Подсказки из готовых источников — для тестов и для экранов, которые источники уже грузили. */
export function counterpartySearchOptionsFromRows(
  strictRows: CounterpartyStrictRow[],
  eavRows: CounterpartyEavRow[],
): SearchableSelectOption[] {
  const { strictById, merged } = mergeCounterpartyRows(strictRows, eavRows);
  return counterpartySearchOptions({
    strictRows,
    eavRows,
    attrsById: new Map(),
    strictById,
    merged,
  });
}

/** Переиспользуем общий маппинг EAV-строк (подпись + поисковый текст) — без второго места. */
export { mapEntityRowsToSearchOptions };
