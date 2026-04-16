import {
  NomenclatureItemType,
  WarehouseDocumentType,
  WarehouseDocumentTypeLabels,
  type WarehouseLookupOption,
} from '@matricarmz/shared';
import { mapWarehouseLookupOptions } from './selectOptions.js';

export const WAREHOUSE_ITEM_TYPE_OPTIONS: Array<{ id: NomenclatureItemType | ''; label: string }> = [
  { id: '', label: 'Все типы' },
  { id: NomenclatureItemType.Engine, label: 'Двигатель' },
  { id: NomenclatureItemType.Material, label: 'Материал' },
  { id: NomenclatureItemType.Component, label: 'Комплектующая' },
  { id: NomenclatureItemType.Assembly, label: 'Узел/Сборка' },
  { id: NomenclatureItemType.Product, label: 'Изделие' },
  { id: NomenclatureItemType.SemiProduct, label: 'Полуфабрикат' },
  { id: NomenclatureItemType.Waste, label: 'Отходы' },
  { id: NomenclatureItemType.ToolConsumable, label: 'Расходник' },
];

export const WAREHOUSE_DOC_TYPE_OPTIONS: Array<{ id: WarehouseDocumentType | ''; label: string }> = [
  { id: '', label: 'Все типы' },
  { id: WarehouseDocumentType.StockReceipt, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockReceipt] },
  { id: WarehouseDocumentType.StockIssue, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockIssue] },
  { id: WarehouseDocumentType.StockTransfer, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockTransfer] },
  { id: WarehouseDocumentType.StockWriteoff, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockWriteoff] },
  { id: WarehouseDocumentType.StockInventory, label: WarehouseDocumentTypeLabels[WarehouseDocumentType.StockInventory] },
];

export const WAREHOUSE_DOC_STATUS_OPTIONS = [
  { id: '', label: 'Все статусы' },
  { id: 'draft', label: 'Черновик' },
  { id: 'posted', label: 'Проведен' },
  { id: 'cancelled', label: 'Отменен' },
];

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
