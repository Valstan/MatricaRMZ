import type { ErpDocumentStatus, ErpDocumentType } from './erp.js';

export const NomenclatureItemType = {
  Engine: 'engine',
  Material: 'material',
  Component: 'component',
  Assembly: 'assembly',
  Product: 'product',
  SemiProduct: 'semi_product',
  Waste: 'waste',
  ToolConsumable: 'tool_consumable',
} as const;

export type NomenclatureItemType = (typeof NomenclatureItemType)[keyof typeof NomenclatureItemType];

export const WarehouseNomenclatureType = {
  Engine: 'engine',
  Component: 'component',
  Assembly: 'assembly',
} as const;

export type WarehouseNomenclatureType = (typeof WarehouseNomenclatureType)[keyof typeof WarehouseNomenclatureType];

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
  sku?: string | null;
  name: string;
  itemType: NomenclatureItemType;
  category?: WarehouseNomenclatureType | string;
  directoryKind?: WarehouseDirectoryKind | null;
  directoryRefId?: string | null;
  groupId: string | null;
  unitId: string | null;
  barcode: string | null;
  minStock: number | null;
  maxStock: number | null;
  defaultBrandId?: string | null;
  isSerialTracked?: boolean;
  defaultWarehouseId: string | null;
  specJson: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export const WarehouseDirectoryKind = {
  EngineBrand: 'engine_brand',
  Part: 'part',
  Tool: 'tool',
  Good: 'good',
  Service: 'service',
} as const;

export type WarehouseDirectoryKind = (typeof WarehouseDirectoryKind)[keyof typeof WarehouseDirectoryKind];

/** Значение `source` в `spec_json` номенклатуры для зеркала карточки детали (см. backend warehouseService). */
export const WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART = 'part' as const;

export type WarehouseNomenclaturePartMirrorSpec = {
  source: typeof WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART;
  partId: string;
  templateId?: string;
  article?: string;
};

export function tryParseWarehousePartNomenclatureMirror(specJson: string | null | undefined): WarehouseNomenclaturePartMirrorSpec | null {
  if (!specJson || !String(specJson).trim()) return null;
  try {
    const parsed = JSON.parse(String(specJson)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.source !== WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART) return null;
    const partId = typeof obj.partId === 'string' && obj.partId.trim() ? obj.partId.trim() : '';
    if (!partId) return null;
    const templateId = typeof obj.templateId === 'string' && obj.templateId.trim() ? obj.templateId.trim() : undefined;
    const article = typeof obj.article === 'string' && obj.article.trim() ? obj.article.trim() : undefined;
    return { source: WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART, partId, ...(templateId ? { templateId } : {}), ...(article ? { article } : {}) };
  } catch {
    return null;
  }
}

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

export const WarehouseIncomingSourceType = {
  OpeningBalance: 'opening_balance',
  SupplierPurchase: 'supplier_purchase',
  ProductionRelease: 'production_release',
  RepairRecovery: 'repair_recovery',
  EngineDismantling: 'engine_dismantling',
} as const;

export type WarehouseIncomingSourceType = (typeof WarehouseIncomingSourceType)[keyof typeof WarehouseIncomingSourceType];

export type WarehouseNomenclatureFilter = {
  /** Одна позиция по id (для карточки без полного списка). */
  id?: string;
  search?: string;
  itemType?: NomenclatureItemType;
  directoryKind?: WarehouseDirectoryKind | string;
  groupId?: string;
  isActive?: boolean;
  /** Пагинация на сервере (по умолчанию backend подставляет безопасный лимит). */
  limit?: number;
  offset?: number;
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

export const WarehouseDocumentType = {
  StockReceipt: 'stock_receipt',
  InventoryOpening: 'inventory_opening',
  PurchaseReceipt: 'purchase_receipt',
  ProductionRelease: 'production_release',
  RepairRecovery: 'repair_recovery',
  EngineDismantling: 'engine_dismantling',
  StockIssue: 'stock_issue',
  StockTransfer: 'stock_transfer',
  StockWriteoff: 'stock_writeoff',
  StockInventory: 'stock_inventory',
} as const;

export type WarehouseDocumentType = (typeof WarehouseDocumentType)[keyof typeof WarehouseDocumentType];

export const WarehouseDocumentTypeLabels: Record<WarehouseDocumentType, string> = {
  [WarehouseDocumentType.StockReceipt]: 'Приход',
  [WarehouseDocumentType.InventoryOpening]: 'Ввод начальных остатков',
  [WarehouseDocumentType.PurchaseReceipt]: 'Приход от поставщика',
  [WarehouseDocumentType.ProductionRelease]: 'Выпуск производства',
  [WarehouseDocumentType.RepairRecovery]: 'Восстановление после ремонта',
  [WarehouseDocumentType.EngineDismantling]: 'Разборка двигателя-донора',
  [WarehouseDocumentType.StockIssue]: 'Расход',
  [WarehouseDocumentType.StockTransfer]: 'Перемещение',
  [WarehouseDocumentType.StockWriteoff]: 'Списание',
  [WarehouseDocumentType.StockInventory]: 'Инвентаризация',
};

/** Значения `erp_document_headers.status` для складских документов (в БД — латиница). */
export const WarehouseDocumentWorkflowStatus = {
  Draft: 'draft',
  Planned: 'planned',
  Posted: 'posted',
  Cancelled: 'cancelled',
} as const;

export type WarehouseDocumentWorkflowStatus =
  (typeof WarehouseDocumentWorkflowStatus)[keyof typeof WarehouseDocumentWorkflowStatus];

/** Подписи для интерфейса (русский язык). */
export const WarehouseDocumentStatusLabels: Record<string, string> = {
  [WarehouseDocumentWorkflowStatus.Draft]: 'Черновик',
  [WarehouseDocumentWorkflowStatus.Planned]: 'Запланировано',
  [WarehouseDocumentWorkflowStatus.Posted]: 'Проведён',
  [WarehouseDocumentWorkflowStatus.Cancelled]: 'Отменён',
};

export function warehouseDocumentStatusLabel(status: string | null | undefined): string {
  const s = String(status ?? '').trim();
  if (!s) return '—';
  return WarehouseDocumentStatusLabels[s] ?? s;
}

/** Порядок статусов в фильтре списка складских документов. */
export const WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER: readonly WarehouseDocumentWorkflowStatus[] = [
  WarehouseDocumentWorkflowStatus.Draft,
  WarehouseDocumentWorkflowStatus.Planned,
  WarehouseDocumentWorkflowStatus.Posted,
  WarehouseDocumentWorkflowStatus.Cancelled,
];

export const WarehouseLookupKind = {
  Warehouses: 'warehouses',
  NomenclatureGroups: 'nomenclature_groups',
  Units: 'units',
  WriteoffReasons: 'writeoff_reasons',
  Counterparties: 'counterparties',
  Employees: 'employees',
  EngineBrands: 'engine_brands',
} as const;

export type WarehouseLookupKind = (typeof WarehouseLookupKind)[keyof typeof WarehouseLookupKind];

export type WarehouseLookupOption = {
  id: string;
  label: string;
  code: string | null;
  isActive?: boolean;
  meta?: Record<string, unknown>;
};

export type WarehouseLookups = {
  warehouses: WarehouseLookupOption[];
  nomenclatureGroups: WarehouseLookupOption[];
  units: WarehouseLookupOption[];
  writeoffReasons: WarehouseLookupOption[];
  counterparties: WarehouseLookupOption[];
  employees: WarehouseLookupOption[];
  engineBrands: WarehouseLookupOption[];
};

export type WarehouseDocumentHeaderPayload = {
  warehouseId: string | null;
  expectedDate: number | null;
  sourceType: WarehouseIncomingSourceType | null;
  sourceRef: string | null;
  contractId: string | null;
  reason: string | null;
  counterpartyId: string | null;
};

export type WarehouseDocumentLinePayload = {
  nomenclatureId: string | null;
  unit: string | null;
  batch: string | null;
  note: string | null;
  cost: number | null;
  warehouseId: string | null;
  fromWarehouseId: string | null;
  toWarehouseId: string | null;
  adjustmentQty: number | null;
  bookQty: number | null;
  actualQty: number | null;
  reason: string | null;
};

export type WarehouseNomenclatureListItem = NomenclatureItem & {
  groupName: string | null;
  unitName: string | null;
  defaultBrandName?: string | null;
  defaultWarehouseName: string | null;
};

export type WarehouseStockListItem = StockBalance & {
  warehouseName: string | null;
  nomenclatureCode: string | null;
  sku?: string | null;
  nomenclatureName: string | null;
  itemType: NomenclatureItemType | null;
  category?: WarehouseNomenclatureType | string | null;
  isSerialTracked?: boolean;
  minStock: number | null;
  maxStock: number | null;
  groupId: string | null;
  groupName: string | null;
  unitId: string | null;
  unitName: string | null;
  defaultWarehouseId: string | null;
  defaultWarehouseName: string | null;
  availableQty: number;
};

export type WarehouseDocumentLineDto = {
  id: string;
  lineNo: number;
  qty: number;
  price: number | null;
  partCardId: string | null;
  nomenclatureId: string | null;
  unit?: string | null;
  batch?: string | null;
  note?: string | null;
  cost?: number | null;
  nomenclatureCode: string | null;
  nomenclatureName: string | null;
  warehouseId: string | null;
  expectedDate?: number | null;
  sourceType?: WarehouseIncomingSourceType | string | null;
  sourceRef?: string | null;
  contractId?: string | null;
  warehouseName: string | null;
  fromWarehouseId: string | null;
  fromWarehouseName: string | null;
  toWarehouseId: string | null;
  toWarehouseName: string | null;
  adjustmentQty: number | null;
  bookQty: number | null;
  actualQty: number | null;
  reason: string | null;
  reasonLabel?: string | null;
  payloadJson: string | null;
};

export type WarehouseDocumentListItem = {
  id: string;
  docType: WarehouseDocumentType;
  docNo: string;
  docDate: number;
  status: ErpDocumentStatus;
  authorId: string | null;
  authorName: string | null;
  departmentId: string | null;
  payloadJson: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  reason: string | null;
  expectedDate?: number | null;
  sourceType?: WarehouseIncomingSourceType | null;
  sourceRef?: string | null;
  contractId?: string | null;
  reasonLabel?: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  createdAt: number;
  updatedAt: number;
  postedAt: number | null;
  deletedAt: number | null;
  linesCount: number;
  totalQty: number;
};

export type WarehouseDocumentDetails = {
  header: WarehouseDocumentListItem;
  lines: WarehouseDocumentLineDto[];
};

export type WarehouseMovementListItem = StockMovement & {
  warehouseName: string | null;
  nomenclatureCode: string | null;
  nomenclatureName: string | null;
  documentDocNo: string | null;
  documentDocType: WarehouseDocumentType | null;
  counterpartyName: string | null;
  reasonLabel?: string | null;
};

export type WarehouseDocumentLineInput = {
  qty: number;
  price?: number | null;
  cost?: number | null;
  partCardId?: string | null;
  nomenclatureId?: string | null;
  unit?: string | null;
  batch?: string | null;
  note?: string | null;
  warehouseId?: string | null;
  fromWarehouseId?: string | null;
  toWarehouseId?: string | null;
  adjustmentQty?: number | null;
  bookQty?: number | null;
  actualQty?: number | null;
  reason?: string | null;
  payloadJson?: string | null;
};

export type WarehouseDocumentUpsertInput = {
  id?: string;
  docType: WarehouseDocumentType;
  status?: ErpDocumentStatus;
  docNo: string;
  docDate?: number;
  departmentId?: string | null;
  authorId?: string | null;
  payloadJson?: string | null;
  header?: {
    warehouseId?: string | null;
    expectedDate?: number | null;
    sourceType?: WarehouseIncomingSourceType | null;
    sourceRef?: string | null;
    contractId?: string | null;
    reason?: string | null;
    counterpartyId?: string | null;
  };
  lines: WarehouseDocumentLineInput[];
};

export type WarehouseForecastIncomingFilter = {
  from: number;
  to: number;
  warehouseId?: string;
};

export type WarehouseForecastIncomingRow = {
  expectedDate: number;
  warehouseId: string;
  nomenclatureId: string;
  nomenclatureCode: string | null;
  nomenclatureName: string | null;
  unit: string | null;
  sourceType: WarehouseIncomingSourceType | string;
  qty: number;
};

export const EngineInstanceStatus = {
  InStock: 'in_stock',
  InRepair: 'in_repair',
  InAssembly: 'in_assembly',
  Reserved: 'reserved',
  Issued: 'issued',
  Archived: 'archived',
} as const;

export type EngineInstanceStatus = (typeof EngineInstanceStatus)[keyof typeof EngineInstanceStatus];

export type EngineInstance = {
  id: string;
  nomenclatureId: string;
  serialNumber: string;
  contractId: string | null;
  currentStatus: EngineInstanceStatus | string;
  warehouseId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type EngineInstanceListItem = EngineInstance & {
  nomenclatureCode: string | null;
  nomenclatureName: string | null;
  warehouseName: string | null;
  contractCode?: string | null;
  contractName?: string | null;
};

export type NomenclatureEngineBrandLink = {
  id: string;
  nomenclatureId: string;
  engineBrandId: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export const EngineAssemblyBomStatus = {
  Draft: 'draft',
  Active: 'active',
  Archived: 'archived',
} as const;

export type EngineAssemblyBomStatus = (typeof EngineAssemblyBomStatus)[keyof typeof EngineAssemblyBomStatus];

export const EngineAssemblyBomComponentType = {
  Sleeve: 'sleeve',
  Piston: 'piston',
  Ring: 'ring',
  Jacket: 'jacket',
  Head: 'head',
  Other: 'other',
} as const;

export type EngineAssemblyBomComponentType = (typeof EngineAssemblyBomComponentType)[keyof typeof EngineAssemblyBomComponentType];

export type EngineAssemblyBomLine = {
  id: string;
  bomId: string;
  componentNomenclatureId: string;
  componentType: EngineAssemblyBomComponentType | string;
  qtyPerUnit: number;
  variantGroup: string | null;
  lineKey?: string | null;
  parentLineKey?: string | null;
  isRequired: boolean;
  priority: number;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type EngineAssemblyBom = {
  id: string;
  name: string;
  engineNomenclatureId: string;
  version: number;
  status: EngineAssemblyBomStatus | string;
  isDefault: boolean;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type EngineAssemblyBomListItem = EngineAssemblyBom & {
  engineNomenclatureCode: string | null;
  engineNomenclatureName: string | null;
  linesCount: number;
};

export type EngineAssemblyBomDetails = {
  header: EngineAssemblyBomListItem;
  lines: EngineAssemblyBomLine[];
};

export type EngineAssemblyBomLineInput = {
  id?: string;
  componentNomenclatureId: string;
  componentType?: EngineAssemblyBomComponentType | string;
  qtyPerUnit: number;
  variantGroup?: string | null;
  lineKey?: string | null;
  parentLineKey?: string | null;
  isRequired?: boolean;
  priority?: number;
  notes?: string | null;
};

export type EngineAssemblyBomUpsertInput = {
  id?: string;
  name: string;
  engineNomenclatureId: string;
  version?: number;
  status?: EngineAssemblyBomStatus | string;
  isDefault?: boolean;
  notes?: string | null;
  lines: EngineAssemblyBomLineInput[];
};

export type EngineAssemblyBomExpandedRow = {
  componentNomenclatureId: string;
  componentNomenclatureCode: string | null;
  componentNomenclatureName: string | null;
  componentType: EngineAssemblyBomComponentType | string;
  qtyPerUnit: number;
  requiredQty: number;
  stockQty: number;
  plannedIncomingQty: number;
  deficitQty: number;
  variantGroup: string | null;
  lineKey?: string | null;
  parentLineKey?: string | null;
  isRequired: boolean;
  priority: number;
};

export type WarehouseBomRelationNode = {
  typeId: string;
  label: string;
  isActive: boolean;
  childTypeIds: string[];
  sortOrder: number;
};

export type WarehouseBomRelationSchema = {
  format: 'bom_relation_schema_v1';
  rootTypeId: string;
  nodes: WarehouseBomRelationNode[];
};

export type WarehouseBomRelationTypeUsage = {
  typeId: string;
  totalLineCount: number;
  activeLineCount: number;
  draftLineCount: number;
  archivedLineCount: number;
};

export const DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA: WarehouseBomRelationSchema = {
  format: 'bom_relation_schema_v1',
  rootTypeId: 'engine',
  nodes: [
    { typeId: 'engine', label: 'Двигатель', isActive: true, childTypeIds: ['sleeve'], sortOrder: 10 },
    { typeId: 'sleeve', label: 'Гильза', isActive: true, childTypeIds: ['piston', 'jacket'], sortOrder: 20 },
    { typeId: 'piston', label: 'Поршень', isActive: true, childTypeIds: ['ring'], sortOrder: 30 },
    { typeId: 'ring', label: 'Кольцо', isActive: true, childTypeIds: [], sortOrder: 40 },
    { typeId: 'jacket', label: 'Рубашка', isActive: true, childTypeIds: ['head'], sortOrder: 50 },
    { typeId: 'head', label: 'Головка', isActive: true, childTypeIds: [], sortOrder: 60 },
    { typeId: 'other', label: 'Прочее', isActive: true, childTypeIds: [], sortOrder: 900 },
  ],
};

function normalizeRelationTypeId(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9._-]/g, '');
}

export function sanitizeWarehouseBomRelationSchema(raw: unknown): WarehouseBomRelationSchema {
  const parsed = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rootTypeId = normalizeRelationTypeId(parsed.rootTypeId) || DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA.rootTypeId;
  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const fallbackById = new Map(DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA.nodes.map((node) => [node.typeId, node]));
  const normalized: WarehouseBomRelationNode[] = [];
  const seen = new Set<string>();
  for (const [idx, item] of rawNodes.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const typeId = normalizeRelationTypeId(rec.typeId);
    if (!typeId || seen.has(typeId)) continue;
    seen.add(typeId);
    const fallback = fallbackById.get(typeId);
    const childTypeIds = Array.isArray(rec.childTypeIds)
      ? Array.from(
          new Set(
            rec.childTypeIds
              .map((value) => normalizeRelationTypeId(value))
              .filter(Boolean)
              .filter((value) => value !== typeId),
          ),
        )
      : fallback?.childTypeIds ?? [];
    normalized.push({
      typeId,
      label: String(rec.label ?? fallback?.label ?? typeId).trim() || typeId,
      isActive: rec.isActive === undefined ? true : Boolean(rec.isActive),
      childTypeIds,
      sortOrder: Number.isFinite(Number(rec.sortOrder)) ? Math.trunc(Number(rec.sortOrder)) : (fallback?.sortOrder ?? (idx + 1) * 10),
    });
  }
  if (!seen.has(rootTypeId)) {
    normalized.push({
      typeId: rootTypeId,
      label: rootTypeId === 'engine' ? 'Двигатель' : rootTypeId,
      isActive: true,
      childTypeIds: [],
      sortOrder: 5,
    });
  }
  const validIds = new Set(normalized.map((node) => node.typeId));
  const sanitizedNodes = normalized
    .map((node) => ({
      ...node,
      childTypeIds: node.childTypeIds.filter((childId) => validIds.has(childId)),
    }))
    .sort((a, b) => (a.sortOrder - b.sortOrder) || a.label.localeCompare(b.label, 'ru'));
  return {
    format: 'bom_relation_schema_v1',
    rootTypeId,
    nodes: sanitizedNodes,
  };
}

