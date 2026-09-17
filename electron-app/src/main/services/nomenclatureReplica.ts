import { resolveNomenclatureComponentTypeId } from '@matricarmz/shared';

/**
 * Оформление строки `erp_nomenclature` из реплики в то, что отдаёт сервер в
 * `GET /warehouse/nomenclature` (`listWarehouseNomenclature`): подписи группы, единицы,
 * склада и родителя, производные `sku` / `category` / `componentTypeId`. Правило одно
 * на обоих концах — список одинаков, откуда бы ни пришёл.
 */

export type NomenclatureReplicaRefs = {
  groupById: ReadonlyMap<string, string>;
  unitById: ReadonlyMap<string, string>;
  /** Ключ — код склада (`warehouse_locations.code`): в номенклатуре `default_warehouse_id` хранит код. */
  warehouseByCode: ReadonlyMap<string, string>;
  parentNameById: ReadonlyMap<string, string>;
};

const LABEL_ATTR_CODES = ['name', 'title', 'label', 'full_name'] as const;

/** Подпись EAV-сущности для lookup-а — то же правило, что у сервера в `listMasterdataLookup`. */
export function masterdataLookupLabel(id: string, attributes: Record<string, unknown>): string {
  const known = LABEL_ATTR_CODES.find((code) => attributes[code] != null && String(attributes[code]).trim() !== '');
  const raw = known ? attributes[known] : (attributes.code ?? id);
  return String(raw ?? id).trim() || id;
}

export function normalizeItemTypeToCategory(itemType: string | null | undefined): 'engine' | 'component' | 'assembly' {
  const t = String(itemType ?? '').toLowerCase();
  if (t === 'engine') return 'engine';
  if (t === 'product' || t === 'semi_product' || t === 'assembly') return 'assembly';
  return 'component';
}

function label(map: ReadonlyMap<string, string>, id: unknown): string | null {
  const key = String(id ?? '').trim();
  if (!key) return null;
  return map.get(key) ?? null;
}

export function decorateNomenclatureReplicaRow(
  row: Record<string, unknown>,
  refs: NomenclatureReplicaRefs,
): Record<string, unknown> {
  const itemType = row.itemType == null ? null : String(row.itemType);
  const category = (row.category as string | null | undefined) ?? normalizeItemTypeToCategory(itemType);
  const spec = {
    componentTypeId: (row.componentTypeId as string | null | undefined) ?? null,
    specJson: (row.specJson as string | null | undefined) ?? null,
    name: (row.name as string | null | undefined) ?? null,
    code: (row.code as string | null | undefined) ?? null,
    category,
    itemType,
  };
  return {
    ...row,
    sku: row.sku ?? row.code ?? null,
    category,
    defaultBrandId: row.defaultBrandId ?? null,
    isSerialTracked: Boolean(row.isSerialTracked ?? (itemType ?? '').toLowerCase() === 'engine'),
    componentTypeId: resolveNomenclatureComponentTypeId(spec),
    // Марок двигателей в реплике нет (сервер читает их из своей таблицы) — как и у сервера без марки.
    defaultBrandName: null,
    groupName: label(refs.groupById, row.groupId),
    parentNomenclatureName: label(refs.parentNameById, row.parentNomenclatureId),
    unitName: label(refs.unitById, row.unitId),
    defaultWarehouseName: label(refs.warehouseByCode, row.defaultWarehouseId),
  };
}
