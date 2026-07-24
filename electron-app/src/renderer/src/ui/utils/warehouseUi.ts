import {
  NomenclatureItemType,
  WarehouseDocumentType,
  WarehouseDocumentTypeLabels,
  type WarehouseLookupOption,
  warehouseDocumentStatusLabel,
} from '@matricarmz/shared';
import { mapWarehouseLookupOptions } from './selectOptions.js';

export const WAREHOUSE_ITEM_TYPE_OPTIONS: Array<{ id: NomenclatureItemType | ''; label: string }> = [
  { id: '', label: 'Все типы' },
  { id: NomenclatureItemType.Part, label: 'Деталь' },
  { id: NomenclatureItemType.Assembly, label: 'Сборочная единица (узел)' },
  { id: NomenclatureItemType.Engine, label: 'Двигатель' },
  { id: NomenclatureItemType.Component, label: 'Комплектующее' },
  { id: NomenclatureItemType.Material, label: 'Материал' },
  { id: NomenclatureItemType.Consumable, label: 'Расходник' },
  { id: NomenclatureItemType.Tool, label: 'Инструмент' },
  { id: NomenclatureItemType.Good, label: 'Товар' },
  { id: NomenclatureItemType.Service, label: 'Услуга' },
  { id: NomenclatureItemType.SemiProduct, label: 'Полуфабрикат' },
  { id: NomenclatureItemType.Product, label: 'Изделие (legacy)' },
  { id: NomenclatureItemType.Waste, label: 'Отходы' },
  { id: NomenclatureItemType.ToolConsumable, label: 'Расходник инструмента (legacy)' },
];

export const WAREHOUSE_ITEM_TYPE_CREATE_OPTIONS: Array<{ id: NomenclatureItemType; label: string; hint: string }> = [
  { id: NomenclatureItemType.Part, label: 'Деталь', hint: 'Изготовленная или покупная деталь' },
  { id: NomenclatureItemType.Assembly, label: 'Сборочная единица', hint: 'Узел из нескольких деталей' },
  { id: NomenclatureItemType.Engine, label: 'Двигатель', hint: 'Готовое изделие с серийным номером' },
  { id: NomenclatureItemType.Component, label: 'Комплектующее', hint: 'Мелкое покупное изделие' },
  { id: NomenclatureItemType.Material, label: 'Материал', hint: 'Сырьё, металлопрокат, краска' },
  { id: NomenclatureItemType.Consumable, label: 'Расходник', hint: 'Прокладки, фильтры, ветошь' },
  { id: NomenclatureItemType.Tool, label: 'Инструмент', hint: 'Длительного пользования, с инвентарным номером' },
  { id: NomenclatureItemType.Good, label: 'Товар', hint: 'Закупка для перепродажи' },
  { id: NomenclatureItemType.Service, label: 'Услуга', hint: 'Работа без складского учёта' },
];

export const WAREHOUSE_DOC_TYPE_OPTIONS: Array<{ id: WarehouseDocumentType | ''; label: string }> = [
  { id: '', label: 'Все типы' },
  { id: WarehouseDocumentType.StockReceipt, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockReceipt] },
  { id: WarehouseDocumentType.InventoryOpening, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.InventoryOpening] },
  { id: WarehouseDocumentType.PurchaseReceipt, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.PurchaseReceipt] },
  { id: WarehouseDocumentType.ProductionRelease, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.ProductionRelease] },
  { id: WarehouseDocumentType.RepairRecovery, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.RepairRecovery] },
  { id: WarehouseDocumentType.EngineDismantling, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.EngineDismantling] },
  { id: WarehouseDocumentType.CustomerSupplied, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.CustomerSupplied] },
  { id: WarehouseDocumentType.StockIssue, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockIssue] },
  { id: WarehouseDocumentType.StockTransfer, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockTransfer] },
  { id: WarehouseDocumentType.StockWriteoff, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockWriteoff] },
  { id: WarehouseDocumentType.StockInventory, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockInventory] },
];

export { warehouseDocumentStatusLabel };

export function warehouseDocTypeLabel(docType: string | null | undefined): string {
  if (!docType) return '—';
  return WarehouseDocumentTypeLabels[docType as WarehouseDocumentType] ?? docType;
}

export function lookupToSelectOptions(rows: WarehouseLookupOption[]) {
  return mapWarehouseLookupOptions(rows);
}

export function lookupLabelById(rows: WarehouseLookupOption[], id: string | null | undefined): string {
  const safeId = String(id ?? '').trim();
  if (!safeId) return '';
  const match = rows.find((row) => row.id === safeId);
  return match?.label ?? '';
}
