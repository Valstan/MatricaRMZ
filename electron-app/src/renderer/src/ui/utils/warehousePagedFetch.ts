import type { WarehouseStockListItem } from '@matricarmz/shared';

const CHUNK = 500;

/** Загружает все строки остатков порциями (для инвентаризации и полной выгрузки по складу). */
export async function fetchWarehouseStockAllPages(args: {
  warehouseId?: string;
  nomenclatureId?: string;
  search?: string;
  lowStockOnly?: boolean;
}): Promise<WarehouseStockListItem[]> {
  let offset = 0;
  const out: WarehouseStockListItem[] = [];
  while (true) {
    const r = await window.matrica.warehouse.stockList({
      ...args,
      limit: CHUNK,
      offset,
    });
    if (!r?.ok) throw new Error(String(r?.error ?? 'stockList'));
    const batch = (r.rows ?? []) as WarehouseStockListItem[];
    out.push(...batch);
    if (!r.hasMore || batch.length === 0) break;
    offset += CHUNK;
    if (offset > 2_000_000) break;
  }
  return out;
}
