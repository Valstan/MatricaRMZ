import type { WarehouseLookupOption } from '@matricarmz/shared';

/**
 * Складские справочники из РЕПЛИКИ — чистые правила сборки подписей.
 *
 * Сервер строит те же списки в `listWarehouseLookups` поверх PostgreSQL, из EAV
 * (`entities` + `attribute_values`) и `warehouse_locations`. Всё это давно синкается
 * клиенту, поэтому справочники можно собрать на месте, без сетевого запроса и без
 * кэша «60 секунд в памяти» (владелец 18.09.2026: «всё, дак всё — пусть будет на
 * клиенте»).
 *
 * Правила подписей ДОЛЖНЫ совпадать с серверными: один и тот же выпадающий список
 * не должен выглядеть по-разному в зависимости от того, откуда его прочитали.
 * Поэтому они собраны здесь по одному и покрыты тестами.
 */

const LABEL_ATTR_CODES = ['name', 'title', 'label', 'full_name'] as const;

function trimmed(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/** Общая подпись EAV-сущности — правило сервера из `listMasterdataLookup`. */
export function lookupLabelFromAttrs(id: string, attrs: Record<string, unknown>): string {
  const known = LABEL_ATTR_CODES.find((code) => trimmed(attrs[code]) !== '');
  const raw = known ? attrs[known] : (attrs.code ?? id);
  return trimmed(raw) || id;
}

/** Необязательные поля подсказки — сервер отдаёт их в `meta`, если они заполнены. */
function lookupMeta(attrs: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (attrs.address != null) meta.address = attrs.address;
  if (attrs.description != null) meta.description = attrs.description;
  return Object.keys(meta).length ? meta : undefined;
}

export function masterdataLookupOption(id: string, attrs: Record<string, unknown>): WarehouseLookupOption {
  const meta = lookupMeta(attrs);
  return {
    id,
    label: lookupLabelFromAttrs(id, attrs),
    code: attrs.code == null ? null : String(attrs.code),
    ...(meta ? { meta } : {}),
  };
}

/**
 * Договор: человекочитаемой метки у него нет — это внутренний номер («20/ГОЗ-25»),
 * дальше казённый номер контракта, дальше наименование ГОЗ. Порядок тот же, что у
 * сервера в `listContractLookup` (строгая `erp_contracts` — зеркало этих же атрибутов).
 */
export function contractLookupOption(id: string, attrs: Record<string, unknown>): WarehouseLookupOption {
  const number = trimmed(attrs.number);
  const label = trimmed(attrs.internal_number) || number || trimmed(attrs.goz_name) || id;
  return { id, label, code: number || null };
}

/** Контрагент (EAV-тип `customer`): подпись — наименование, код — краткое имя. */
export function counterpartyLookupOption(id: string, attrs: Record<string, unknown>): WarehouseLookupOption {
  return {
    id,
    label: trimmed(attrs.name) || id,
    code: attrs.short_name == null ? null : String(attrs.short_name),
  };
}

/** Марка двигателя: подпись — наименование, кода у неё нет (как и на сервере). */
export function engineBrandLookupOption(id: string, attrs: Record<string, unknown>): WarehouseLookupOption {
  return { id, label: trimmed(attrs.name) || id, code: null };
}

/** Порядок выдачи — по подписи, по-русски: тот же `localeCompare('ru')`, что на сервере. */
export function sortLookupOptions(options: WarehouseLookupOption[]): WarehouseLookupOption[] {
  return [...options].sort((left, right) => left.label.localeCompare(right.label, 'ru'));
}
