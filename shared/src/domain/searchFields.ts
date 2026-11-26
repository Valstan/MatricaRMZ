// Реестр полей поиска по видам сущностей + сопоставление совпадения с полем.
//
// Задание владельца (промт КАРМАНА #137, 25.11.2026): поиск должен знать, ГДЕ именно
// совпало, и отдавать выдачу, сгруппированной по этому месту («по номеру двигателя — 3»).
// Раньше запись склеивалась в одну строку (`collectRecordText`), и совпадение находилось
// «где-то в записи» — оператор не видел, почему строка попала в выдачу.
//
// Правила владельца (25.11.2026), зашитые в порядок реестра:
//  * для двигателей самым верхним идёт совпадение по номеру двигателя;
//  * для прочих сущностей самым верхним — совпадение по наименованию;
//  * остальные поля — ниже, в порядке реестра.
//
// Поле ищется по строке списка: у строки бывает несколько ключей под одно поле
// (номер двигателя — `engineNumber`, «сквозной номер» — `rmzCode`), берётся первый непустой.
// Ключи перечислены вручную, поэтому рядом стоит сторож: поле реестра, которого нет
// в строке, — это молчаливо пустая группа в выдаче.

import {
  LOOKUP_FILTER_MIN_SCORE,
  matchPreparedLookupOption,
  prepareLookupOptions,
  searchPreparedLookupOptionsTiered,
  type PreparedLookupOption,
  type SearchMode,
} from './tieredSearch.js';
import type { GlobalSearchKind } from './globalSearch.js';

export type SearchFieldDescriptor = {
  /** Стабильный идентификатор поля (внутри вида сущности). */
  id: string;
  /** Подпись, которую видит оператор: «номер двигателя». */
  label: string;
  /**
   * Подпись поля В ИМЕНИТЕЛЬНОМ падеже — для кнопки выбора «где искать»
   * (промт КАРМАНА #138, 25.11.2026).
   *
   * `label` — дательный падеж: он всегда читается как «по <label>» («по номеру
   * двигателя»), поэтому в кнопке нужен другой падеж — «номер двигателя».
   * Одной строкой обойтись нельзя: русский падеж не выводится из слова механически.
   */
  title: string;
  /** Ключи строки, где может лежать поле; берётся первый непустой. */
  keys: string[];
};

export type SearchFieldMatch = {
  fieldId: string;
  /** Подпись поля из реестра. */
  label: string;
};

/**
 * Реестр полей по видам сущностей. Порядок полей = порядок групп в выдаче
 * (приоритет владельца от 25.11.2026).
 *
 * Подпись поля — в дательном падеже: она всегда читается как «по <подпись>»
 * («по номеру двигателя — 3»), поэтому отдельное «по» не нужно ни в заголовке
 * группы, ни в бейдже строки списка.
 */
export const SEARCH_FIELDS: Partial<Record<GlobalSearchKind, SearchFieldDescriptor[]>> = {
  engine: [
    { id: 'engine_number', label: 'номеру двигателя', title: 'номер двигателя', keys: ['engineNumber', 'engine_number', 'number'] },
    { id: 'internal_number', label: 'внутреннему номеру', title: 'внутренний номер', keys: ['internalNumberFull', 'internalNumber', 'internal_number'] },
    { id: 'contract', label: 'договору', title: 'номер контракта', keys: ['contractName', 'contractSectionNumber', 'contractNumber'] },
    { id: 'brand', label: 'марке', title: 'марка', keys: ['engineBrand', 'brand'] },
    { id: 'customer', label: 'заказчику', title: 'заказчик', keys: ['customerName', 'customer'] },
    { id: 'rmz', label: 'сквозному номеру', title: 'сквозной номер', keys: ['rmzCode', 'rmzNumber'] },
    { id: 'note', label: 'примечанию', title: 'примечание', keys: ['engineNote', 'note'] },
    { id: 'kind', label: 'виду', title: 'вид двигателя', keys: ['kind', 'kindName'] },
  ],
  contract: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['displayName', 'name', 'title', 'contractName'] },
    { id: 'number', label: 'номеру договора', title: 'номер договора', keys: ['number', 'contractNumber', 'docNo'] },
    { id: 'internal_number', label: 'внутреннему номеру', title: 'внутренний номер', keys: ['internalNumber', 'internal_number'] },
    { id: 'counterparty', label: 'контрагенту', title: 'контрагент', keys: ['counterpartyName', 'counterparty', 'customerName'] },
    { id: 'kind', label: 'виду', title: 'вид договора', keys: ['kind', 'kindName'] },
    { id: 'goz', label: 'наименованию ГОЗ', title: 'наименование ГОЗ', keys: ['gozName', 'goz_name'] },
    { id: 'amount', label: 'сумме', title: 'сумма', keys: ['amount', 'sum', 'contractAmount'] },
  ],
  counterparty: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['displayName', 'name', 'fullName', 'title'] },
    { id: 'code', label: 'коду', title: 'код', keys: ['code', 'number'] },
    { id: 'inn', label: 'ИНН', title: 'ИНН', keys: ['inn', 'taxId'] },
  ],
  employee: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['fullName', 'displayName', 'name', 'fio'] },
    { id: 'personnel_no', label: 'табельному номеру', title: 'табельный номер', keys: ['personnelNo', 'personnelNumber', 'tabel'] },
    { id: 'post', label: 'должности', title: 'должность', keys: ['post', 'position', 'jobTitle'] },
    { id: 'login', label: 'логину', title: 'логин', keys: ['login', 'username'] },
  ],
  nomenclature: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title'] },
    { id: 'code', label: 'коду', title: 'код', keys: ['code'] },
    { id: 'sku', label: 'артикулу', title: 'артикул', keys: ['sku', 'article'] },
    { id: 'barcode', label: 'штрихкоду', title: 'штрихкод', keys: ['barcode'] },
  ],
  stock_document: [
    { id: 'number', label: 'номеру документа', title: 'номер документа', keys: ['number', 'docNo'] },
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title'] },
  ],
  work_order: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title', 'workOrderName'] },
    { id: 'number', label: 'номеру наряда', title: 'номер наряда', keys: ['number', 'docNo', 'orderNumber'] },
  ],
  work_sheet: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title', 'workSheetName'] },
    { id: 'number', label: 'номеру', title: 'номер', keys: ['number', 'docNo'] },
  ],
  request: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title'] },
    { id: 'number', label: 'номеру заявки', title: 'номер заявки', keys: ['number', 'docNo', 'requestNumber'] },
  ],
  engine_brand: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title', 'brandName'] },
  ],
  service: [{ id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title'] }],
  product: [{ id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title'] }],
  tool: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title'] },
    { id: 'code', label: 'коду', title: 'код', keys: ['code', 'number', 'inventoryNumber'] },
  ],
  tool_property: [
    { id: 'name', label: 'наименованию', title: 'наименование', keys: ['name', 'displayName', 'title'] },
  ],
};

export function searchFieldsFor(kind: GlobalSearchKind | undefined): SearchFieldDescriptor[] {
  if (!kind) return [];
  return SEARCH_FIELDS[kind] ?? [];
}

/**
 * Поля вида сущности для кнопки выбора «где искать» (промт КАРМАНА #138).
 *
 * Кнопка предлагает ТОЛЬКО поля, по которым реально ищется: реестр — единственный
 * источник правды, иначе кнопка предложит поле, которого в строке нет, и выдача
 * окажется пустой (см. сторож `searchFields.guard.test.ts`).
 */
export type SearchFieldOption = {
  /** Вид сущности, к которому относится поле. */
  kind: GlobalSearchKind;
  /** Идентификатор поля внутри вида. */
  id: string;
  /** Подпись поля в именительном падеже: «номер двигателя». */
  title: string;
  /** Подпись в дательном падеже — для заголовка группы «по номеру двигателя». */
  label: string;
};

export function searchFieldOptionsFor(kind: GlobalSearchKind | undefined): SearchFieldOption[] {
  return searchFieldsFor(kind).map((f) => ({ kind: kind as GlobalSearchKind, id: f.id, title: f.title, label: f.label }));
}

/**
 * Поля вида, которые в ЭТИХ строках вообще есть (промт КАРМАНА #138).
 *
 * Реестр описывает сущность вообще — он один на палитру, справочники и списки. Но строка
 * списка может быть другой формы: у контракта в справочнике есть `displayName`, а в строке
 * списка — `number` и `counterparty`. Поле, которого в строке нет, обещает ПУСТУЮ выдачу,
 * а оператор решит, что поиск сломан (владелец 25.11.2026: «различать надо явно»).
 *
 * Поэтому список спрашивает реестр: «какие из твоих полей тут есть?» — и предлагает
 * именно их. Поле, которое есть, но в конкретной строке не заполнено, остаётся в списке:
 * это «совпадений нет», а не «поле недоступно».
 */
export function searchFieldOptionsForRows(kind: GlobalSearchKind | undefined, rows: unknown[]): SearchFieldOption[] {
  const fields = searchFieldsFor(kind);
  if (!fields.length) return [];
  const keys = new Set<string>();
  // Форма строки одна на весь список — хватает первых строк, чтобы её узнать.
  const limit = Math.min(rows.length, 200);
  for (let i = 0; i < limit; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row as Record<string, unknown>)) keys.add(key);
  }
  return fields
    .filter((f) => f.keys.some((k) => keys.has(k)))
    .map((f) => ({ kind: kind as GlobalSearchKind, id: f.id, title: f.title, label: f.label }));
}

/** Описание поля по виду сущности и идентификатору. */
export function searchFieldDescriptorOf(
  kind: GlobalSearchKind | undefined,
  fieldId: string,
): SearchFieldDescriptor | undefined {
  return searchFieldsFor(kind).find((f) => f.id === fieldId);
}

/** Значение выбранного поля в строке — то же, что и для группировки (#137). */
export function searchFieldValueOf(row: unknown, kind: GlobalSearchKind | undefined, fieldId: string): string {
  const descriptor = searchFieldDescriptorOf(kind, fieldId);
  if (!descriptor) return '';
  return searchFieldValue(row, descriptor.keys);
}

/** Значение поля в строке: первый непустой из ключей. Объекты распаковываются по текстовым полям. */
export function searchFieldValue(row: unknown, keys: string[]): string {
  if (!row || typeof row !== 'object') return '';
  const obj = row as Record<string, unknown>;
  for (const key of keys) {
    const raw = obj[key];
    if (raw == null) continue;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      const text = String(raw).trim();
      if (text) return text;
      continue;
    }
    if (typeof raw === 'object') {
      const nested = raw as Record<string, unknown>;
      for (const nestedKey of ['text', 'value', 'label', 'name', 'title']) {
        const v = nested[nestedKey];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return '';
}

/**
 * Какие поля строки совпали с запросом.
 *
 * Матчер — тот же тир-1, что и в списках (точный режим по умолчанию, «≈ Похожие» по кнопке),
 * поэтому «где совпало» не может противоречить тому, что строка вообще нашлась.
 * Подпись поля кладём в `searchText`, а `id`/`label` оставляем пустыми: иначе запрос
 * «номер» совпал бы с САМОЙ подписью поля («номер двигателя»), а не со значением.
 */
export type PreparedSearchField = {
  field: SearchFieldDescriptor;
  prepared: PreparedLookupOption<{ id: string; label: string; searchText: string }>;
};

/** Подготовка полей строки — один раз на набор строк, не на каждый ввод. */
export function prepareSearchFields<T>(row: T, kind: GlobalSearchKind | undefined): PreparedSearchField[] {
  const fields = searchFieldsFor(kind);
  if (!fields.length) return [];
  const usable = fields
    .map((f) => ({ field: f, option: { id: '', label: '', searchText: searchFieldValue(row, f.keys) } }))
    .filter((e) => e.option.searchText !== '');
  const prepared = prepareLookupOptions(usable.map((e) => e.option));
  return usable
    .map((e, i) => ({ field: e.field, prepared: prepared[i] }))
    .filter((e): e is PreparedSearchField => Boolean(e.prepared));
}

/** Совпавшие поля подготовленной строки — в порядке реестра (приоритет владельца). */
export function matchPreparedSearchFields(
  prepared: PreparedSearchField[],
  query: string,
  mode: SearchMode = 'exact',
): SearchFieldMatch[] {
  const q = String(query ?? '').trim();
  if (!q || !prepared.length) return [];
  // Тир-3 (опечатки) живёт на уровне НАБОРА, а не строки: «похожие» имеет смысл, когда
  // есть с чем сравнивать. Поэтому и здесь — набор полей строки: если точных совпадений
  // нет, ищем опечатку (в режиме «точный» тир-3 не включается — как и в списках).
  const tiered = searchPreparedLookupOptionsTiered(
    prepared.map((e) => e.prepared),
    q,
    { minScore: LOOKUP_FILTER_MIN_SCORE, mode },
  );
  const ranked = tiered.primary.length > 0 ? tiered.primary : tiered.similar;
  const matched = new Set(ranked.map((o) => prepared.find((e) => e.prepared.option === o)?.field.id ?? ''));
  return prepared
    .map((e) => e.field)
    .filter((f) => matched.has(f.id))
    .map((f) => ({ fieldId: f.id, label: f.label }));
}

/** Короткая форма для одиночной строки (тесты, точечные проверки). */
export function matchSearchFields<T>(
  row: T,
  kind: GlobalSearchKind | undefined,
  query: string,
  mode: SearchMode = 'exact',
): SearchFieldMatch[] {
  return matchPreparedSearchFields(prepareSearchFields(row, kind), query, mode);
}

/**
 * Совпало ли поле — по одному полю, а не по всей записи (промт КАРМАНА #138).
 *
 * Матчер — тот же тир-1/тир-2 и тот же режим, что и у обычного поиска: выбор поля
 * сужает, ГДЕ искать, и не должен менять строгость (владелец 25.11.2026: «выбор поля
 * и режим — независимые переключатели»). Тир-3 (опечатки) включается только в режиме
 * «≈ Похожие» и только если точных совпадений нет.
 */
export type SearchFieldHit = { matched: boolean; similar: boolean };

export function matchPreparedSearchField(
  prepared: PreparedSearchField[],
  query: string,
  mode: SearchMode = 'exact',
  fieldId: string,
  opts?: { fuzzyFallback?: boolean },
): SearchFieldHit {
  const entry = prepared.find((e) => e.field.id === fieldId);
  // Поля в строке нет — это не «не совпало», а «нечего было искать»: обе разницы
  // для оператора выглядят одинаково (пусто), но причины разные.
  if (!entry) return { matched: false, similar: false };
  return matchPreparedLookupOption(entry.prepared, query, {
    minScore: LOOKUP_FILTER_MIN_SCORE,
    mode,
    ...(opts?.fuzzyFallback === false ? { fuzzyFallback: false } : {}),
  });
}

/** То же, но по одному значению поля (без подготовки строки). */
export function matchSearchFieldValue(
  value: string,
  query: string,
  mode: SearchMode = 'exact',
  opts?: { fuzzyFallback?: boolean },
): SearchFieldHit {
  const text = String(value ?? '').trim();
  if (!text) return { matched: false, similar: false };
  const prepared = prepareLookupOptions([{ id: '', label: '', searchText: text }])[0]!;
  return matchPreparedLookupOption(prepared, query, {
    minScore: LOOKUP_FILTER_MIN_SCORE,
    mode,
    ...(opts?.fuzzyFallback === false ? { fuzzyFallback: false } : {}),
  });
}

/**
 * СУЖЕНИЕ ВЫДАЧИ ПО ПОЛЮ (промт КАРМАНА #138, 25.11.2026).
 *
 * Владелец: «если человек ищет по номеру двигателя, он может выбрать вот этот параметр,
 * и тогда будут выдаваться только совпадения по номерам двигателей, остальные вхождения
 * он показывать не будет». Значит — не «внизу», а ИСКЛЮЧАЮТСЯ: в выдаче остаются строки,
 * у которых значение ВЫБРАННОГО поля совпало с запросом.
 *
 * Строка, у которой этого поля нет (или оно пустое), в выдачу не попадает: «совпадений
 * по этому полю нет» — честный ответ, а не «поле недоступно».
 *
 * Возвращаются ИНДЕКСЫ строк: вызывающий сам решает порядок (обычно — как в обычном
 * поиске, по релевантности тир-1).
 */
export function filterRowsBySearchField<T>(
  records: T[],
  fieldRows: Array<PreparedSearchField[]>,
  query: string,
  mode: SearchMode = 'exact',
  fieldId: string,
  opts?: { fuzzyFallback?: boolean },
): { indexes: number[]; similarMode: boolean } {
  const q = String(query ?? '').trim();
  if (!q) return { indexes: records.map((_, i) => i), similarMode: false };
  const indexes: number[] = [];
  let similarMode = false;
  for (let i = 0; i < records.length; i += 1) {
    const prepared = fieldRows[i];
    if (!prepared?.length) continue;
    const hit = matchPreparedSearchField(prepared, q, mode, fieldId, opts);
    if (!hit.matched) continue;
    if (hit.similar) similarMode = true;
    indexes.push(i);
  }
  return { indexes, similarMode };
}

export type SearchFieldBucket<T> = {
  /** Поле совпадения; `null` — совпадение есть, но поле вне реестра («где-то в записи»). */
  fieldId: string | null;
  /** Заголовок группы: «по номеру двигателя». */
  title: string;
  rows: T[];
};

/**
 * Группировка выдачи по месту совпадения.
 *
 * Строка попадает в группу ПЕРВОГО совпавшего поля по реестру (приоритет владельца):
 * если совпало и «номер двигателя», и «договор» — строка показывается в группе
 * «по номеру двигателя», чтобы выдача не двоилась.
 * Строки без совпавшего зарегистрированного поля идут в «совпадение в записи» — честно:
 * поле мы не знаем, а молчать об этом нельзя.
 */
export function groupRowsBySearchField<T>(
  kind: GlobalSearchKind | undefined,
  rows: T[],
  keyOf: (row: T) => string,
  matches: Map<string, SearchFieldMatch[]>,
): SearchFieldBucket<T>[] {
  const fields = searchFieldsFor(kind);
  const order = new Map(fields.map((f, i) => [f.id, i]));
  const buckets = new Map<string, SearchFieldBucket<T>>();
  const unknown: SearchFieldBucket<T> = { fieldId: null, title: 'совпадение в записи', rows: [] };

  for (const row of rows) {
    const hit = matches.get(keyOf(row))?.[0];
    if (!hit) {
      unknown.rows.push(row);
      continue;
    }
    let bucket = buckets.get(hit.fieldId);
    if (!bucket) {
      // Подпись группы берём из РЕЕСТРА, а не из совпадения: реестр — единственный
      // источник правды о том, как поле называется оператору.
      const descriptor = fields.find((f) => f.id === hit.fieldId);
      bucket = { fieldId: hit.fieldId, title: `по ${descriptor?.label ?? hit.label}`, rows: [] };
      buckets.set(hit.fieldId, bucket);
    }
    bucket.rows.push(row);
  }

  const ordered = [...buckets.values()].sort(
    (a, b) => (order.get(a.fieldId ?? '') ?? 999) - (order.get(b.fieldId ?? '') ?? 999),
  );
  if (unknown.rows.length) ordered.push(unknown);
  return ordered;
}
