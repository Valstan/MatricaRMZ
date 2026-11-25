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
    { id: 'engine_number', label: 'номеру двигателя', keys: ['engineNumber', 'engine_number', 'number'] },
    { id: 'internal_number', label: 'внутреннему номеру', keys: ['internalNumberFull', 'internalNumber', 'internal_number'] },
    { id: 'contract', label: 'договору', keys: ['contractName', 'contractSectionNumber', 'contractNumber'] },
    { id: 'brand', label: 'марке', keys: ['engineBrand', 'brand'] },
    { id: 'customer', label: 'заказчику', keys: ['customerName', 'customer'] },
    { id: 'rmz', label: 'сквозному номеру', keys: ['rmzCode', 'rmzNumber'] },
    { id: 'note', label: 'примечанию', keys: ['engineNote', 'note'] },
    { id: 'kind', label: 'виду', keys: ['kind', 'kindName'] },
  ],
  contract: [
    { id: 'name', label: 'наименованию', keys: ['displayName', 'name', 'title', 'contractName'] },
    { id: 'number', label: 'номеру договора', keys: ['number', 'contractNumber', 'docNo'] },
    { id: 'counterparty', label: 'контрагенту', keys: ['counterpartyName', 'counterparty', 'customerName'] },
    { id: 'amount', label: 'сумме', keys: ['amount', 'sum'] },
    { id: 'signed_at', label: 'дате подписания', keys: ['signedAt', 'signed_at'] },
  ],
  counterparty: [
    { id: 'name', label: 'наименованию', keys: ['displayName', 'name', 'fullName', 'title'] },
    { id: 'code', label: 'коду', keys: ['code', 'number'] },
    { id: 'inn', label: 'ИНН', keys: ['inn', 'taxId'] },
  ],
  employee: [
    { id: 'name', label: 'наименованию', keys: ['fullName', 'displayName', 'name', 'fio'] },
    { id: 'personnel_no', label: 'табельному номеру', keys: ['personnelNo', 'personnelNumber', 'tabel'] },
    { id: 'post', label: 'должности', keys: ['post', 'position', 'jobTitle'] },
    { id: 'login', label: 'логину', keys: ['login', 'username'] },
  ],
  nomenclature: [
    { id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title'] },
    { id: 'code', label: 'коду', keys: ['code'] },
    { id: 'sku', label: 'артикулу', keys: ['sku', 'article'] },
    { id: 'barcode', label: 'штрихкоду', keys: ['barcode'] },
  ],
  stock_document: [
    { id: 'number', label: 'номеру документа', keys: ['number', 'docNo'] },
    { id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title'] },
  ],
  work_order: [
    { id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title', 'workOrderName'] },
    { id: 'number', label: 'номеру наряда', keys: ['number', 'docNo', 'orderNumber'] },
  ],
  work_sheet: [
    { id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title', 'workSheetName'] },
    { id: 'number', label: 'номеру', keys: ['number', 'docNo'] },
  ],
  request: [
    { id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title'] },
    { id: 'number', label: 'номеру заявки', keys: ['number', 'docNo', 'requestNumber'] },
  ],
  engine_brand: [
    { id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title', 'brandName'] },
  ],
  service: [{ id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title'] }],
  product: [{ id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title'] }],
  tool: [
    { id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title'] },
    { id: 'code', label: 'коду', keys: ['code', 'number', 'inventoryNumber'] },
  ],
  tool_property: [
    { id: 'name', label: 'наименованию', keys: ['name', 'displayName', 'title'] },
  ],
};

export function searchFieldsFor(kind: GlobalSearchKind | undefined): SearchFieldDescriptor[] {
  if (!kind) return [];
  return SEARCH_FIELDS[kind] ?? [];
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
