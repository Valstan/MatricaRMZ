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

