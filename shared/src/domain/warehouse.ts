import type { ErpDocumentStatus, ErpDocumentType } from './erp.js';

export const NomenclatureItemType = {
  Material: 'material',
  Component: 'component',
  Product: 'product',
  SemiProduct: 'semi_product',
  Waste: 'waste',
  ToolConsumable: 'tool_consumable',
} as const;

export type NomenclatureItemType = (typeof NomenclatureItemType)[keyof typeof NomenclatureItemType];

export const StockMovementType = {
  Receipt: 'receipt',
  Issue: 'issue',
  TransferIn: 'transfer_in',
  TransferOut: 'transfer_out',
  Writeoff: 'writeoff',
  InventorySurplus: 'inventory_surplus',
  InventoryShortage: 'inventory_shortage',
} as const;

export type StockMovementType = (typeof StockMovementType)[keyof typeof StockMovementType];

export const StockDirection = {
  In: 'in',
  Out: 'out',
} as const;

export type StockDirection = (typeof StockDirection)[keyof typeof StockDirection];

export type NomenclatureItem = {
  id: string;
  code: string;
  name: string;
  itemType: NomenclatureItemType;
  groupId: string | null;
  unitId: string | null;
  barcode: string | null;
  minStock: number | null;
  maxStock: number | null;
  defaultWarehouseId: string | null;
  specJson: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type StockBalance = {
  id: string;
  nomenclatureId: string | null;
  partCardId: string | null;
  warehouseId: string;
  qty: number;
  reservedQty: number;
  updatedAt: number;
};

export type StockMovement = {
  id: string;
  nomenclatureId: string;
  warehouseId: string;
  documentHeaderId: string | null;
  movementType: StockMovementType;
  qty: number;
  direction: StockDirection;
  counterpartyId: string | null;
  reason: string | null;
  performedAt: number;
  performedBy: string | null;
  createdAt: number;
};

export type WarehouseDocumentLine = {
  lineNo: number;
  nomenclatureId: string | null;
  partCardId?: string | null;
  qty: number;
  price: number | null;
  payloadJson: string | null;
};

export type WarehouseDocument = {
  id: string;
  docType: ErpDocumentType;
  docNo: string;
  docDate: number;
  status: ErpDocumentStatus;
  authorId: string | null;
  departmentId: string | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
  postedAt: number | null;
  deletedAt: number | null;
  lines: WarehouseDocumentLine[];
};

export type WarehouseNomenclatureFilter = {
  search?: string;
  itemType?: NomenclatureItemType;
  groupId?: string;
  isActive?: boolean;
};

export type WarehouseStockFilter = {
  warehouseId?: string;
  nomenclatureId?: string;
  search?: string;
  lowStockOnly?: boolean;
};

export type WarehouseDocumentsFilter = {
  docType?: ErpDocumentType;
  status?: ErpDocumentStatus;
  fromDate?: number;
  toDate?: number;
};

