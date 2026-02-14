export type WorkOrderCrewMember = {
  employeeId: string;
  employeeName: string;
  ktu: number;
  payoutRub?: number;
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

export type WorkOrderPayload = {
  kind: 'work_order';
  version: 1;

  operationId: string;
  workOrderNumber: number;
  orderDate: number;

  partId: string | null;
  partName: string;

  crew: WorkOrderCrewMember[];
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
};

