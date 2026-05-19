export type WorkOrderCrewMember = {
  employeeId: string;
  employeeName: string;
  ktu: number;
  payoutRub?: number;
  payoutFrozen?: boolean;
  manualPayoutRub?: number;
};

export type WorkOrderWorkLine = {
  lineNo: number;
  serviceId: string | null;
  serviceName: string;
  unit: string;
  qty: number;
  priceRub: number;
  amountRub: number;
  // Дополнительные поля наряда
  productNumber?: string;
  engineId?: string | null;
  engineNumber?: string;
  engineBrandId?: string | null;
  engineBrandName?: string;
};

export type WorkOrderAuditTrailItem = {
  at: number;
  by: string;
  action: string;
  note?: string | null;
};

export type WorkOrderWorkGroup = {
  groupId: string;
  partId: string | null;
  partName: string;
  lines: WorkOrderWorkLine[];
};

function workOrderSafeNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function workOrderLineAmountRub(qty: number, priceRub: number): number {
  return Math.round(qty * priceRub * 100) / 100;
}

/** Нормализует строку вида работ наряда, сохраняя № изделия и привязку к двигателю. */
export function normalizeWorkOrderLine(line: unknown, lineNo: number): WorkOrderWorkLine {
  const raw = line && typeof line === 'object' ? (line as Record<string, unknown>) : {};
  const qty = Math.max(0, workOrderSafeNum(raw.qty, 0));
  const priceRub = Math.max(0, workOrderSafeNum(raw.priceRub, 0));
  const result: WorkOrderWorkLine = {
    lineNo,
    serviceId: raw.serviceId ? String(raw.serviceId) : null,
    serviceName: String(raw.serviceName ?? ''),
    unit: String(raw.unit ?? ''),
    qty,
    priceRub,
    amountRub: workOrderLineAmountRub(qty, priceRub),
  };

  const productNumber = String(raw.productNumber ?? '').trim();
  if (productNumber) result.productNumber = productNumber;

  const engineId = raw.engineId ? String(raw.engineId).trim() : '';
  if (engineId) {
    result.engineId = engineId;
    const engineNumber = String(raw.engineNumber ?? '').trim();
    if (engineNumber) result.engineNumber = engineNumber;
    const engineBrandId = raw.engineBrandId ? String(raw.engineBrandId).trim() : '';
    if (engineBrandId) result.engineBrandId = engineBrandId;
    const engineBrandName = String(raw.engineBrandName ?? '').trim();
    if (engineBrandName) result.engineBrandName = engineBrandName;
  }

  return result;
}

export const WorkOrderKind = {
  Repair: 'repair',
  Assembly: 'assembly',
} as const;

export type WorkOrderKind = (typeof WorkOrderKind)[keyof typeof WorkOrderKind];

export const WORK_ORDER_KIND_LABELS: Record<WorkOrderKind, string> = {
  [WorkOrderKind.Repair]: 'Ремонтный',
  [WorkOrderKind.Assembly]: 'Сборочный',
};

/** Строка планируемого расхода деталей на сборочном наряде. */
export type WorkOrderConsumedLine = {
  lineNo: number;
  nomenclatureId: string;
  qty: number;
  sourceWarehouseId: string;
};

/** Строка планируемого выпуска отремонтированных деталей на ремонтном наряде. */
export type WorkOrderProducedLine = {
  lineNo: number;
  nomenclatureId: string;
  qty: number;
  targetWarehouseId: string;
};

export const WORK_ORDER_PAYLOAD_VERSION = 3 as const;

export type WorkOrderPayload = {
  kind: 'work_order';
  version: 2 | 3;

  operationId: string;
  workOrderNumber: number;
  orderDate: number;

  crew: WorkOrderCrewMember[];
  workGroups: WorkOrderWorkGroup[];
  freeWorks: WorkOrderWorkLine[];
  works: WorkOrderWorkLine[];

  totalAmountRub: number;
  basePerWorkerRub: number;
  payouts: Array<{
    employeeId: string;
    employeeName: string;
    ktu: number;
    amountRub: number;
  }>;

  auditTrail?: WorkOrderAuditTrailItem[];
  // Legacy v1 fields can still be present in old payloads before normalization.
  partId?: string | null;
  partName?: string;

  // v3 (parts-movement / engine-assembly module). All optional for back-compat.
  workshopId?: string;
  workOrderKind?: WorkOrderKind;
  consumedLines?: WorkOrderConsumedLine[];
  producedLines?: WorkOrderProducedLine[];
  /** ID складского документа, созданного при закрытии наряда (engine_dismantling/repair_recovery/assembly_consumption/assembly_return). */
  linkedDocumentId?: string;
};

function normalizeConsumedLine(raw: unknown, lineNo: number): WorkOrderConsumedLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const nomenclatureId = String(rec.nomenclatureId ?? '').trim();
  if (!nomenclatureId) return null;
  const qty = Math.max(0, workOrderSafeNum(rec.qty, 0));
  if (qty <= 0) return null;
  const sourceWarehouseId = String(rec.sourceWarehouseId ?? '').trim() || 'default';
  return { lineNo, nomenclatureId, qty, sourceWarehouseId };
}

function normalizeProducedLine(raw: unknown, lineNo: number): WorkOrderProducedLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const nomenclatureId = String(rec.nomenclatureId ?? '').trim();
  if (!nomenclatureId) return null;
  const qty = Math.max(0, workOrderSafeNum(rec.qty, 0));
  if (qty <= 0) return null;
  const targetWarehouseId = String(rec.targetWarehouseId ?? '').trim() || 'default';
  return { lineNo, nomenclatureId, qty, targetWarehouseId };
}

function isWorkOrderKind(value: unknown): value is WorkOrderKind {
  return value === WorkOrderKind.Repair || value === WorkOrderKind.Assembly;
}

/**
 * Принимает payload любой версии (v1/v2/v3) и возвращает нормализованные v3-поля.
 * Не модифицирует исходный объект; ничего не теряет — старые поля сохраняются.
 */
export function normalizeWorkOrderPayloadV3Fields(raw: unknown): Pick<WorkOrderPayload, 'workshopId' | 'workOrderKind' | 'consumedLines' | 'producedLines' | 'linkedDocumentId'> {
  if (!raw || typeof raw !== 'object') return {};
  const rec = raw as Record<string, unknown>;

  const result: Pick<WorkOrderPayload, 'workshopId' | 'workOrderKind' | 'consumedLines' | 'producedLines' | 'linkedDocumentId'> = {};

  const workshopId = typeof rec.workshopId === 'string' ? rec.workshopId.trim() : '';
  if (workshopId) result.workshopId = workshopId;

  if (isWorkOrderKind(rec.workOrderKind)) result.workOrderKind = rec.workOrderKind;

  if (Array.isArray(rec.consumedLines)) {
    const consumed = rec.consumedLines
      .map((row, idx) => normalizeConsumedLine(row, idx + 1))
      .filter((row): row is WorkOrderConsumedLine => row !== null);
    if (consumed.length > 0) result.consumedLines = consumed;
  }

  if (Array.isArray(rec.producedLines)) {
    const produced = rec.producedLines
      .map((row, idx) => normalizeProducedLine(row, idx + 1))
      .filter((row): row is WorkOrderProducedLine => row !== null);
    if (produced.length > 0) result.producedLines = produced;
  }

  const linkedDocumentId = typeof rec.linkedDocumentId === 'string' ? rec.linkedDocumentId.trim() : '';
  if (linkedDocumentId) result.linkedDocumentId = linkedDocumentId;

  return result;
}

