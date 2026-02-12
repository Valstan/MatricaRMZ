export const ErpObjectLayer = {
  Dictionary: 'dictionary',
  Card: 'card',
  Document: 'document',
  Register: 'register',
  Journal: 'journal',
} as const;

export type ErpObjectLayer = (typeof ErpObjectLayer)[keyof typeof ErpObjectLayer];

export const ErpModule = {
  Parts: 'parts',
  Tools: 'tools',
  Counterparties: 'counterparties',
  Contracts: 'contracts',
  Employees: 'employees',
} as const;

export type ErpModule = (typeof ErpModule)[keyof typeof ErpModule];

export const ErpDocumentType = {
  SupplyRequest: 'supply_request',
  RepairOrder: 'repair_order',
  PartsIssue: 'parts_issue',
  PartsReceipt: 'parts_receipt',
  PartsWriteoff: 'parts_writeoff',
  PartsTransfer: 'parts_transfer',
} as const;

export type ErpDocumentType = (typeof ErpDocumentType)[keyof typeof ErpDocumentType];

export const ErpDocumentStatus = {
  Draft: 'draft',
  Posted: 'posted',
  Closed: 'closed',
  Cancelled: 'cancelled',
} as const;

export type ErpDocumentStatus = (typeof ErpDocumentStatus)[keyof typeof ErpDocumentStatus];

export type ErpPartTemplate = {
  id: string;
  code: string;
  name: string;
  specJson: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ErpPartCard = {
  id: string;
  templateId: string;
  serialNo: string | null;
  cardNo: string | null;
  attrsJson: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type ErpDocumentHeader = {
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
};

export type ErpDocumentLine = {
  id: string;
  headerId: string;
  lineNo: number;
  partCardId: string | null;
  qty: number;
  price: number | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
};
