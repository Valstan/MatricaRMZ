import type { WarehouseNomenclatureListItem, WarehouseStockListItem } from '@matricarmz/shared';

// Обобщённая позиция (parent_nomenclature_id, план bom-simplify-2026-09 E3): родитель без
// артикула + артикульные варианты. Склад считает по конкретной строке; свод по родителю —
// только представление. Здесь чистая логика двух переключателей «свёрнуто / развёрнуто».

export type StockRollupRow = WarehouseStockListItem & {
  /** Сколько вариантов сложено в строку свода (0 — обычная строка). */
  variantCount?: number;
};

/**
 * Свод остатков по обобщённым позициям: варианты одного родителя на одном складе складываются
 * в одну строку. Строки без родителя проходят как есть. Мин/макс у свода не задаются —
 * они принадлежат конкретной строке, и складывать их было бы враньём.
 */
export function rollupStockByParent(rows: readonly WarehouseStockListItem[]): StockRollupRow[] {
  const out: StockRollupRow[] = [];
  const groups = new Map<string, StockRollupRow>();
  for (const row of rows) {
    const parentId = String(row.parentNomenclatureId ?? '').trim();
    if (!parentId) {
      out.push(row);
      continue;
    }
    const key = `${parentId}::${String(row.warehouseId ?? '')}`;
    const acc = groups.get(key);
    if (!acc) {
      const created: StockRollupRow = {
        ...row,
        id: `parent:${key}`,
        nomenclatureId: parentId,
        nomenclatureCode: '',
        sku: null,
        nomenclatureName: row.parentNomenclatureName ?? row.nomenclatureName,
        parentNomenclatureId: null,
        parentNomenclatureName: null,
        minStock: null,
        maxStock: null,
        qty: Number(row.qty ?? 0),
        reservedQty: Number(row.reservedQty ?? 0),
        availableQty: Number(row.availableQty ?? 0),
        variantCount: 1,
      };
      groups.set(key, created);
      out.push(created);
      continue;
    }
    acc.qty = Number(acc.qty ?? 0) + Number(row.qty ?? 0);
    acc.reservedQty = Number(acc.reservedQty ?? 0) + Number(row.reservedQty ?? 0);
    acc.availableQty = Number(acc.availableQty ?? 0) + Number(row.availableQty ?? 0);
    acc.variantCount = (acc.variantCount ?? 0) + 1;
  }
  return out;
}

/**
 * Свёрнутый список номенклатуры: варианты прячутся под родителя, если родитель есть в этом же
 * списке; вариант «чужого» родителя (другая группа/страница) остаётся видимым, иначе он пропал бы
 * с экрана без следа. Возвращает счётчик вариантов по родителю для подписи «(N вариантов)».
 */
export function collapseNomenclatureVariants(rows: readonly WarehouseNomenclatureListItem[]): {
  rows: WarehouseNomenclatureListItem[];
  variantCountByParent: Map<string, number>;
} {
  const present = new Set(rows.map((r) => String(r.id)));
  const variantCountByParent = new Map<string, number>();
  for (const r of rows) {
    const p = String(r.parentNomenclatureId ?? '').trim();
    if (p) variantCountByParent.set(p, (variantCountByParent.get(p) ?? 0) + 1);
  }
  return {
    rows: rows.filter((r) => {
      const p = String(r.parentNomenclatureId ?? '').trim();
      return !p || !present.has(p);
    }),
    variantCountByParent,
  };
}
