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

export type WorkOrderPayload = {
  kind: 'work_order';
  version: 2;

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
};

