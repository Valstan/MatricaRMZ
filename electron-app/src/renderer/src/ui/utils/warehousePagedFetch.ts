import type {
  NomenclatureItemType,
  WarehouseDocumentListItem,
  WarehouseDocumentType,
  WarehouseNomenclatureListItem,
  WarehouseStockListItem,
} from '@matricarmz/shared';

const CHUNK = 500;

/** Загружает все строки остатков порциями (для инвентаризации и полной выгрузки по складу). */
export async function fetchWarehouseStockAllPages(args: {
  warehouseId?: string;
  nomenclatureId?: string;
  search?: string;
  lowStockOnly?: boolean;
}): Promise<WarehouseStockListItem[]> {
  return (await fetchWarehouseStockAllPagesEx(args)).rows;
}

/** Как fetchWarehouseStockAllPages, но с флагом searchSimilar (#035: «похожие» вместо пустого результата). */
export async function fetchWarehouseStockAllPagesEx(args: {
  warehouseId?: string;
  nomenclatureId?: string;
  search?: string;
  lowStockOnly?: boolean;
}): Promise<{ rows: WarehouseStockListItem[]; searchSimilar: boolean }> {
  let offset = 0;
  const out: WarehouseStockListItem[] = [];
  let searchSimilar = false;
  while (true) {
    const r = await window.matrica.warehouse.stockList({
      ...args,
      limit: CHUNK,
      offset,
    });
    if (!r?.ok) throw new Error(String(r?.error ?? 'stockList'));
    if (offset === 0) searchSimilar = Boolean((r as { searchSimilar?: boolean }).searchSimilar);
    const batch = (r.rows ?? []) as WarehouseStockListItem[];
    out.push(...batch);
    if (!r.hasMore || batch.length === 0) break;
    offset += CHUNK;
    if (offset > 2_000_000) break;
  }
  return { rows: out, searchSimilar };
}

/** Загружает все позиции номенклатуры порциями (для полной клиентской сортировки развёрнутой группы). */
export async function fetchWarehouseNomenclatureAllPages(args: {
  search?: string;
  itemType?: NomenclatureItemType;
  directoryKind?: string;
  groupId?: string;
}): Promise<WarehouseNomenclatureListItem[]> {
  let offset = 0;
  const out: WarehouseNomenclatureListItem[] = [];
  while (true) {
    const r = await window.matrica.warehouse.nomenclatureList({ ...args, limit: CHUNK, offset });
    if (!r?.ok) throw new Error(String(r?.error ?? 'nomenclatureList'));
    const batch = (r.rows ?? []) as WarehouseNomenclatureListItem[];
    out.push(...batch);
    if (!r.hasMore || batch.length === 0) break;
    offset += CHUNK;
    if (offset > 2_000_000) break;
  }
  return out;
}

/** Загружает все документы склада порциями (для полной клиентской сортировки списка). */
export async function fetchWarehouseDocumentsAllPages(args: {
  docType?: WarehouseDocumentType;
  statusIn?: string[];
  search?: string;
  warehouseId?: string;
  fromDate?: number;
  toDate?: number;
}): Promise<WarehouseDocumentListItem[]> {
  let offset = 0;
  const out: WarehouseDocumentListItem[] = [];
  while (true) {
    const r = await window.matrica.warehouse.documentsList({ ...args, limit: CHUNK, offset });
    if (!r?.ok) throw new Error(String(r?.error ?? 'documentsList'));
    const batch = (r.rows ?? []) as WarehouseDocumentListItem[];
    out.push(...batch);
    if (!r.hasMore || batch.length === 0) break;
    offset += CHUNK;
    if (offset > 2_000_000) break;
  }
  return out;
}
