import type { ErpDocumentStatus, ErpDocumentType } from './erp.js';

export const NomenclatureItemType = {
  Engine: 'engine',
  Assembly: 'assembly',
  Part: 'part',
  Component: 'component',
  Material: 'material',
  Consumable: 'consumable',
  Tool: 'tool',
  Good: 'good',
  Service: 'service',
  SemiProduct: 'semi_product',
  Product: 'product',
  Waste: 'waste',
  ToolConsumable: 'tool_consumable',
} as const;

export type NomenclatureItemType = (typeof NomenclatureItemType)[keyof typeof NomenclatureItemType];

export const NOMENCLATURE_ITEM_TYPE_LABELS: Record<NomenclatureItemType, string> = {
  engine: 'Двигатель',
  assembly: 'Сборочная единица (узел)',
  part: 'Деталь',
  component: 'Комплектующее',
  material: 'Материал',
  consumable: 'Расходник',
  tool: 'Инструмент',
  good: 'Товар',
  service: 'Услуга',
  semi_product: 'Полуфабрикат',
  product: 'Готовая продукция',
  waste: 'Отходы',
  tool_consumable: 'Расходник инструмента',
};

export const NOMENCLATURE_ITEM_TYPE_HAS_STOCK: Record<NomenclatureItemType, boolean> = {
  engine: true,
  assembly: true,
  part: true,
  component: true,
  material: true,
  consumable: true,
  tool: true,
  good: true,
  service: false,
  semi_product: true,
  product: true,
  waste: true,
  tool_consumable: true,
};

export const NOMENCLATURE_ITEM_TYPE_PRIMARY_ORDER: NomenclatureItemType[] = [
  'part',
  'assembly',
  'engine',
  'component',
  'material',
  'consumable',
  'tool',
  'good',
  'service',
  'semi_product',
];

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
  DismantleIn: 'dismantle_in',
  DismantleScrapIn: 'dismantle_scrap_in',
  RepairOut: 'repair_out',
  RepairIn: 'repair_in',
  AssemblyConsumptionOut: 'assembly_consumption_out',
  AssemblyConsumptionIn: 'assembly_consumption_in',
  AssemblyReturnOut: 'assembly_return_out',
  AssemblyReturnInRework: 'assembly_return_in_rework',
  AssemblyReturnInScrap: 'assembly_return_in_scrap',
} as const;

export type StockMovementType = (typeof StockMovementType)[keyof typeof StockMovementType];

export const STOCK_MOVEMENT_REVERSAL_PREFIX = 'reversal_' as const;

export function reversalMovementType(original: string): string {
  return `${STOCK_MOVEMENT_REVERSAL_PREFIX}${original}`;
}

export function isReversalMovementType(movementType: string | null | undefined): boolean {
  return Boolean(movementType && String(movementType).startsWith(STOCK_MOVEMENT_REVERSAL_PREFIX));
}

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

/**
 * Извлекает `componentTypeId` из specJson номенклатуры. Поле задаётся в карточке
 * номенклатуры (v1.21.2+); если поле не задано — вернётся null и вызывающий код
 * должен применить fallback-эвристику `inferBomComponentTypeFromNomenclature`.
 */
export function readWarehouseNomenclatureComponentTypeId(specJson: string | null | undefined): string | null {
  if (!specJson || !String(specJson).trim()) return null;
  try {
    const parsed = JSON.parse(String(specJson)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const raw = (parsed as Record<string, unknown>).componentTypeId;
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    return value || null;
  } catch {
    return null;
  }
}

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
  warehouseLocationId?: string | null;
  qty: number;
  reservedQty: number;
  updatedAt: number;
};

export type StockMovement = {
  id: string;
  nomenclatureId: string;
  warehouseId: string;
  warehouseLocationId?: string | null;
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
  CustomerSupplied: 'customer_supplied',
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
  CustomerSupplied: 'customer_supplied',
  AssemblyConsumption: 'assembly_consumption',
  AssemblyReturn: 'assembly_return',
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
  [WarehouseDocumentType.CustomerSupplied]: 'Давальческий приход',
  [WarehouseDocumentType.AssemblyConsumption]: 'Списание в сборку',
  [WarehouseDocumentType.AssemblyReturn]: 'Возврат из сборки',
  [WarehouseDocumentType.StockIssue]: 'Расход',
  [WarehouseDocumentType.StockTransfer]: 'Перемещение',
  [WarehouseDocumentType.StockWriteoff]: 'Списание',
  [WarehouseDocumentType.StockInventory]: 'Инвентаризация',
};

/** Режим возврата из сборки: rework — обратно в ремфонд, scrap — в утиль. */
export const AssemblyReturnMode = {
  Rework: 'rework',
  Scrap: 'scrap',
} as const;

export type AssemblyReturnMode = (typeof AssemblyReturnMode)[keyof typeof AssemblyReturnMode];

export const ASSEMBLY_RETURN_MODE_LABELS: Record<AssemblyReturnMode, string> = {
  [AssemblyReturnMode.Rework]: 'На доработку',
  [AssemblyReturnMode.Scrap]: 'В утиль',
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
  contracts: WarehouseLookupOption[];
  nomenclatureItemTypes?: WarehouseLookupOption[];
  nomenclatureProperties?: WarehouseLookupOption[];
  nomenclatureTemplates?: WarehouseLookupOption[];
};

export type NomenclaturePropertyDataType = 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'json';

export type WarehouseNomenclatureProperty = {
  id: string;
  code: string;
  name: string;
  dataType: NomenclaturePropertyDataType;
  isRequired: boolean;
  optionsJson: string | null;
  description?: string | null;
};

/** Элемент массива `properties_json` шаблона: ссылка на сущность `nomenclature_property` по `id`; значения в карточке — в `specJson.propertyValues[propertyId]`. */
export type WarehouseNomenclatureTemplateProperty = {
  propertyId: string;
  required?: boolean;
  sortOrder?: number;
  defaultValue?: unknown;
};

export type WarehouseNomenclatureTemplate = {
  id: string;
  code: string;
  name: string;
  itemTypeCode: string | null;
  directoryKind: string | null;
  properties: WarehouseNomenclatureTemplateProperty[];
  description?: string | null;
};

export type WarehouseDocumentHeaderPayload = {
  warehouseId: string | null;
  expectedDate: number | null;
  sourceType: WarehouseIncomingSourceType | null;
  sourceRef: string | null;
  contractId: string | null;
  reason: string | null;
  counterpartyId: string | null;
  /** Ф3 (G3): адресная выдача/списание — привязка документа к двигателю (entities.id, опционально). */
  engineId: string | null;
  /** Ф3 (G3): привязка к наряду (operations.id) + человекочитаемый номер для карточки/печати. */
  workOrderId: string | null;
  workOrderNo: string | null;
  /** Ф4 (G5): на сторно-документе — ссылка на исходный проведённый документ. Ставит только сервер. */
  reversalOfId: string | null;
  reversalOfDocNo: string | null;
  /** Ф4 (G5): на исходном документе — каким сторно-документом он сторнирован. Ставит только сервер. */
  reversedByDocumentId: string | null;
  reversedByDocNo: string | null;
  reversedAt: number | null;
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
  /**
   * Тип BOM-компонента (sleeve/piston/.../engine) для группировки в `GroupedSearchSelect`.
   * Источник: `specJson.componentTypeId` (приоритет) или эвристика `inferBomComponentTypeFromNomenclature`.
   * Значение `null` означает «Прочее» в UI группировки.
   */
  componentTypeId?: string | null;
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
  warehouseLocationId?: string | null;
  warehouseName: string | null;
  reason: string | null;
  expectedDate?: number | null;
  sourceType?: WarehouseIncomingSourceType | null;
  sourceRef?: string | null;
  contractId?: string | null;
  reasonLabel?: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  engineId?: string | null;
  workOrderId?: string | null;
  workOrderNo?: string | null;
  reversalOfId?: string | null;
  reversalOfDocNo?: string | null;
  reversedByDocumentId?: string | null;
  reversedByDocNo?: string | null;
  reversedAt?: number | null;
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
    engineId?: string | null;
    workOrderId?: string | null;
    workOrderNo?: string | null;
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
  contractSectionNumber: string | null;
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
  contractSectionNumber?: string | null;
};

export const EngineAssemblyBomStatus = {
  Draft: 'draft',
  Active: 'active',
  Archived: 'archived',
} as const;

export type EngineAssemblyBomStatus = (typeof EngineAssemblyBomStatus)[keyof typeof EngineAssemblyBomStatus];

export type AssemblyExecutionProfile = {
  version: number;
  workshopId?: string;
  hiddenFields: string[];
  signatureBlocks?: Array<{ blockId: string; slots: Array<{ caption?: string; employeeId?: string }> }>;
  printSettings?: Record<string, unknown>;
  works: Array<{
    serviceId: string;
    serviceName: string;
    unit: string;
    qty: number;
    priceRub: number;
  }>;
  sourceTemplateId?: string;
  sourceTemplateName?: string;
};

export const EngineAssemblyBomComponentType = {
  Sleeve: 'sleeve',
  Piston: 'piston',
  Ring: 'ring',
  Jacket: 'jacket',
  Head: 'head',
  Carter: 'carter',
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
  /** Норма расхода, % (G8). null = не задана. */
  normPercent?: number | null;
  /** Ключ позиции — группирует взаимозаменяемые варианты в одну позицию. null = позиция-одиночка. */
  positionKey?: string | null;
  /** Имя позиции («Картер верхний»), отдельно от имени детали. */
  positionLabel?: string | null;
  /** Основной вариант позиции (идёт в прогноз/сборку). По умолчанию true. */
  isDefaultOption?: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type EngineAssemblyBom = {
  id: string;
  name: string;
  /** Марки двигателей из справочника (entities) — M:N. Одна BOM может покрывать несколько марок. */
  engineBrandIds: string[];
  /** Марки, для которых эта BOM выбрана основным источником сборки. */
  defaultForBrandIds?: string[];
  /** Устарело: привязка к номенклатуре; не используется в новых спецификациях. */
  engineNomenclatureId?: string | null;
  version: number;
  status: EngineAssemblyBomStatus | string;
  isDefault: boolean;
  /** Явный основной вариант комплекта. null = базовые строки без variantGroup. */
  defaultVariantKey?: string | null;
  /** Профиль выполнения сборки, версионируемый вместе с BOM. */
  executionProfile?: AssemblyExecutionProfile | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type EngineAssemblyBomListItem = EngineAssemblyBom & {
  engineNomenclatureCode?: string | null;
  engineNomenclatureName?: string | null;
  /** Количество вариантов сборки в BOM (уникальных variantGroup + base). 0 = пустая BOM, 1 = классическая. */
  variantsCount: number;
};

export type EngineAssemblyBomDetails = {
  header: EngineAssemblyBomListItem;
  lines: EngineAssemblyBomLine[];
};

export type AssemblyPlanCandidate = {
  bomId: string;
  bomName: string;
  version: number;
  defaultVariantKey: string | null;
};

export type AssemblyPlanResolution =
  | {
      ok: true;
      engineId: string;
      engineBrandId: string;
      snapshot: import('./workOrder.js').AssemblyBomSnapshot;
      materialHash: string;
    }
  | {
      ok: false;
      code: 'engine_not_found' | 'engine_brand_missing' | 'bom_missing' | 'bom_conflict' | 'variant_missing' | 'profile_missing';
      error: string;
      engineBrandId?: string;
      candidates?: AssemblyPlanCandidate[];
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
  /** Норма расхода, % (G8): доля двигателей, которым при ремонте требуется замена детали. */
  normPercent?: number | null;
  positionKey?: string | null;
  positionLabel?: string | null;
  isDefaultOption?: boolean;
};

/**
 * Норма расхода из notes BOM-строки (G8): типизированное поле `normPercent` меты
 * `bom_line_meta_v1`, fallback — человеческий текст «… норма расхода N%» (импорт УТД-20/В-84
 * писал только текст до типизации). Возвращает % (>0, до 2 знаков) либо null.
 */
export function extractBomLineNormPercent(rawNotes: string | null | undefined): number | null {
  const raw = String(rawNotes ?? '').trim();
  if (!raw) return null;
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (String(rec.format ?? '') === 'bom_line_meta_v1') {
        const typed = Number(rec.normPercent);
        if (Number.isFinite(typed) && typed > 0) return Math.round(typed * 100) / 100;
        text = rec.text == null ? '' : String(rec.text);
      }
    }
  } catch {
    // не JSON — обычный текст примечания
  }
  const m = /норма\s+расхода\s+(\d+(?:[.,]\d+)?)\s*%/i.exec(text);
  if (!m) return null;
  const value = Number(m[1]!.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

export type EngineAssemblyBomUpsertInput = {
  id?: string;
  name: string;
  /** Список марок двигателей, к которым применима эта спецификация (минимум одна). */
  engineBrandIds: string[];
  defaultForBrandIds?: string[];
  /**
   * Номенклатура «двигатель» для марки (колонка legacy). Сервер может вывести сам;
   * поле нужно для совместимости со старым API, где оно было обязательным в теле POST.
   */
  engineNomenclatureId?: string | null;
  version?: number;
  status?: EngineAssemblyBomStatus | string;
  isDefault?: boolean;
  defaultVariantKey?: string | null;
  executionProfile?: AssemblyExecutionProfile | null;
  notes?: string | null;
  lines: EngineAssemblyBomLineInput[];
};

/** Legacy: номенклатура типа engine с defaultBrandId = марке (колонка `engine_nomenclature_id`), если такие позиции ведёте. */
export function pickEngineNomenclatureIdForEngineBrand(
  nomenclatureRows: Array<{
    id: string;
    defaultBrandId?: string | null;
    itemType?: string | null;
    category?: string | null;
  }>,
  engineBrandId: string,
): string | null {
  const brand = String(engineBrandId ?? '').trim();
  if (!brand) return null;
  const isEngine = (r: (typeof nomenclatureRows)[number]) => {
    const it = String(r.itemType ?? '').toLowerCase();
    const cat = String(r.category ?? '').toLowerCase();
    return it === 'engine' || cat === 'engine';
  };
  const hit = nomenclatureRows.find((r) => String(r.defaultBrandId ?? '').trim() === brand && isEngine(r));
  return hit ? String(hit.id) : null;
}

/**
 * Клиентский выбор номенклатуры для технической заглушки в черновых строках BOM (совпадает с порядком на сервере).
 *
 * v1.21.3: убран fallback на «первую попавшуюся» — раньше это приводило к тому,
 * что пустая черновая строка получала uuid случайной детали (например, «Гильза 303-07-22»),
 * и при reload пользователь видел эту деталь в строке Картера.
 *
 * Возвращается только engine-номенклатура, привязанная к марке. Если для марки нет
 * engine-номенклатуры — null, вызывающий код обязан показать пользователю чёткую ошибку.
 */
export function pickBomDraftStubNomenclatureFromMeta(
  nomenclatureRows: Array<{
    id: string;
    defaultBrandId?: string | null;
    itemType?: string | null;
    category?: string | null;
  }>,
  engineBrandId: string,
): string | null {
  return pickEngineNomenclatureIdForEngineBrand(nomenclatureRows, engineBrandId);
}

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

/** Нормализация ключей узла/родителя в BOM (как на сервере). */
export function normalizeBomRelationKey(raw: string | null | undefined): string | null {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
  return value || null;
}

export type EngineBomSkeletonBlockLine = {
  componentNomenclatureId: string;
  componentType: string;
  qtyPerUnit: number;
  variantGroup: string;
  lineKey: string | null;
  parentLineKey: string | null;
  isRequired: boolean;
  priority: number;
  notes: string | null;
};

/**
 * Один связный блок строк по глобальной схеме: один variantGroup на все строки блока,
 * ключи узлов уникальны в пределах блока за счёт префикса (несколько блоков в одной BOM).
 */
export function buildEngineBomSkeletonBlockLines(args: {
  schema: WarehouseBomRelationSchema;
  stubComponentNomenclatureId: string;
  /** Один и тот же для всех строк блока (вариант сборки). */
  variantGroupId: string;
  /** Уникальный среди блоков префикс для lineKey/parentLineKey (например b-abc12). */
  lineKeyPrefix: string;
}): EngineBomSkeletonBlockLine[] {
  const rootId = String(args.schema.rootTypeId ?? 'engine').trim().toLowerCase();
  const nodes = (args.schema.nodes ?? []).filter((n) => n && n.isActive !== false);
  const stubId = String(args.stubComponentNomenclatureId).trim();
  const vg = String(args.variantGroupId).trim();
  const prefixRaw = String(args.lineKeyPrefix).trim() || 'block';
  const prefix = normalizeBomRelationKey(prefixRaw) || 'block';

  const parentTypeFor = (typeId: string): string | null => {
    const tid = String(typeId).trim().toLowerCase();
    for (const n of nodes) {
      const nid = String(n.typeId ?? '').trim().toLowerCase();
      const kids = (n.childTypeIds ?? []).map((c) => String(c).trim().toLowerCase());
      if (!kids.includes(tid)) continue;
      if (nid === rootId) return null;
      return nid;
    }
    return null;
  };

  const candidates = nodes
    .map((n) => ({
      typeId: String(n.typeId ?? '').trim().toLowerCase(),
      sortOrder: Number.isFinite(Number(n.sortOrder)) ? Math.trunc(Number(n.sortOrder)) : 100,
    }))
    .filter((n) => n.typeId && n.typeId !== rootId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.typeId.localeCompare(b.typeId, 'ru'));

  const seen = new Set<string>();
  const lines: EngineBomSkeletonBlockLine[] = [];
  for (const row of candidates) {
    const typeId = row.typeId;
    if (seen.has(typeId)) continue;
    seen.add(typeId);
    const parentType = parentTypeFor(typeId);
    const lineKey = normalizeBomRelationKey(`${prefix}-${typeId}`);
    const parentLineKey = parentType ? normalizeBomRelationKey(`${prefix}-${parentType}`) : null;
    lines.push({
      componentNomenclatureId: stubId,
      componentType: typeId,
      qtyPerUnit: 0,
      variantGroup: vg,
      lineKey,
      parentLineKey,
      isRequired: true,
      priority: row.sortOrder,
      notes: 'Черновик строки: укажите номенклатуру компонента.',
    });
  }
  return lines;
}

/**
 * Поиск типа BOM-компонента по тексту (имя/код) и категории номенклатуры.
 * Используется как fallback в backend listNomenclature и в backfill сценариях,
 * когда у номенклатуры не задано явное `componentTypeId` в `specJson`.
 *
 * Возвращает typeId из глобальной BOM-схемы (sleeve/piston/...) или 'engine' для категории engine.
 * Возвращает null если ничего не сматчилось — клиент покажет такую номенклатуру в группе «Прочее».
 */
const BOM_COMPONENT_TYPE_TOKENS: ReadonlyArray<{ typeId: string; tokens: ReadonlyArray<string> }> = [
  { typeId: 'sleeve', tokens: ['гильз', 'втулк', 'sleeve', 'liner'] },
  { typeId: 'piston', tokens: ['порш', 'piston'] },
  { typeId: 'ring', tokens: ['кольц', 'ring'] },
  { typeId: 'jacket', tokens: ['рубаш', 'jacket'] },
  { typeId: 'head', tokens: ['голов', 'head'] },
  { typeId: 'carter', tokens: ['картер', 'carter', 'crankcase'] },
];

export function inferBomComponentTypeFromNomenclature(args: {
  name?: string | null;
  code?: string | null;
  category?: string | null;
  itemType?: string | null;
}): string | null {
  const category = String(args.category ?? '').trim().toLowerCase();
  const itemType = String(args.itemType ?? '').trim().toLowerCase();
  if (category === 'engine' || itemType === 'engine') return 'engine';
  const haystack = `${String(args.name ?? '')} ${String(args.code ?? '')}`.toLowerCase();
  if (!haystack.trim()) return null;
  for (const entry of BOM_COMPONENT_TYPE_TOKENS) {
    if (entry.tokens.some((token) => haystack.includes(token))) return entry.typeId;
  }
  return null;
}

/**
 * Единственный источник истины для определения `componentTypeId` номенклатуры:
 * 1) явный `componentTypeId` колонки `erp_nomenclature.component_type_id` (v1.22.0 block C, миграция 0053);
 * 2) явно заданное `specJson.componentTypeId` (карточка номенклатуры, v1.21.2+) — backward-compat
 *    на transitional period пока UI не переключён на колонку (block D) и пока backfill не прогнан на проде;
 * 3) fallback на эвристику `inferBomComponentTypeFromNomenclature` по name/code/category/itemType.
 *
 * Используется и для отдачи `componentTypeId` в `listWarehouseNomenclature`, и для
 * backend-валидации соответствия `componentType` строки BOM ↔ типа её номенклатуры
 * при upsert (auto-fix в v1.21.3+).
 */
export function resolveNomenclatureComponentTypeId(row: {
  componentTypeId?: string | null;
  specJson?: string | null;
  name?: string | null;
  code?: string | null;
  category?: string | null;
  itemType?: string | null;
}): string | null {
  const fromColumn = typeof row.componentTypeId === 'string' ? row.componentTypeId.trim() : '';
  if (fromColumn) return fromColumn;
  const fromSpec = readWarehouseNomenclatureComponentTypeId(row.specJson ?? null);
  if (fromSpec) return fromSpec;
  return inferBomComponentTypeFromNomenclature({
    name: row.name ?? null,
    code: row.code ?? null,
    category: row.category ?? null,
    itemType: row.itemType ?? null,
  });
}

export type GroupedNomenclatureGroup = {
  groupId: string;
  groupLabel: string;
  items: Array<{
    id: string;
    label: string;
    hintText?: string;
    componentTypeId: string | null;
  }>;
};

/**
 * Группирует номенклатурные позиции по типу BOM-компонента для виджета `GroupedSearchSelect`.
 * Порядок групп — по `sortOrder` глобальной BOM-схемы. Активные типы без позиций пропускаются.
 * Item'ы без `componentTypeId` (или с typeId не из схемы) попадают в группу «Прочее» в конце.
 *
 * Внутри группы item'ы сортируются по label (русская локаль).
 */
export function buildGroupedNomenclatureOptions(args: {
  items: Array<{ id: string; label: string; hintText?: string; componentTypeId?: string | null }>;
  schema: WarehouseBomRelationSchema;
  /** Метка для группы «Прочее» (для type=null и для item'ов с неизвестным типом). По умолчанию «Прочее». */
  otherGroupLabel?: string;
}): GroupedNomenclatureGroup[] {
  const rootId = String(args.schema.rootTypeId ?? 'engine').trim().toLowerCase();
  const typeOrder = new Map<string, { label: string; sortOrder: number }>();
  for (const node of args.schema.nodes ?? []) {
    const typeId = String(node.typeId ?? '').trim().toLowerCase();
    if (!typeId || typeId === rootId) continue;
    if (node.isActive === false) continue;
    typeOrder.set(typeId, {
      label: String(node.label ?? typeId).trim() || typeId,
      sortOrder: Number.isFinite(Number(node.sortOrder)) ? Math.trunc(Number(node.sortOrder)) : 100,
    });
  }
  const bucketByType = new Map<string | null, GroupedNomenclatureGroup>();
  for (const item of args.items) {
    const rawType = item.componentTypeId == null ? null : String(item.componentTypeId).trim().toLowerCase() || null;
    const knownType = rawType && typeOrder.has(rawType) ? rawType : null;
    const bucketKey = knownType;
    let bucket = bucketByType.get(bucketKey);
    if (!bucket) {
      bucket = {
        groupId: knownType ?? 'other',
        groupLabel: knownType ? typeOrder.get(knownType)!.label : (args.otherGroupLabel ?? 'Прочее'),
        items: [],
      };
      bucketByType.set(bucketKey, bucket);
    }
    bucket.items.push({
      id: String(item.id),
      label: String(item.label),
      ...(item.hintText !== undefined ? { hintText: item.hintText } : {}),
      componentTypeId: knownType,
    });
  }
  const result = Array.from(bucketByType.values()).sort((a, b) => {
    const aOrder = a.groupId === 'other' ? Number.POSITIVE_INFINITY : (typeOrder.get(a.groupId)?.sortOrder ?? 100);
    const bOrder = b.groupId === 'other' ? Number.POSITIVE_INFINITY : (typeOrder.get(b.groupId)?.sortOrder ?? 100);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.groupLabel.localeCompare(b.groupLabel, 'ru');
  });
  for (const group of result) {
    group.items.sort((a, b) => a.label.localeCompare(b.label, 'ru', { numeric: true }));
  }
  return result;
}

