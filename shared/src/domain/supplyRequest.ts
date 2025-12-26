export type SupplyRequestStatus =
  | 'draft'
  | 'signed'
  | 'director_approved'
  | 'accepted'
  | 'fulfilled_full'
  | 'fulfilled_partial';

export type SupplyRequestDelivery = {
  deliveredAt: number; // ms epoch
  qty: number;
  note?: string | null;
};

export type SupplyRequestItem = {
  lineNo: number;
  name: string;
  qty: number;
  unit: string;
  note?: string | null;
  deliveries?: SupplyRequestDelivery[];
};

export type SupplyRequestSignature = {
  userId?: string | null;
  username?: string | null;
  signedAt: number; // ms epoch
};

export type SupplyRequestAuditTrailItem = {
  at: number;
  by: string; // username
  action: string;
  note?: string | null;
};

import type { FileRef } from './fileStorage.js';

export type SupplyRequestPayload = {
  kind: 'supply_request';
  version: 1;

  // identity
  operationId: string; // operations.id
  requestNumber: string;

  // header
  compiledAt: number; // дата составления
  acceptedAt?: number | null; // дата принятия снабжением
  fulfilledAt?: number | null; // дата исполнения

  title: string;
  status: SupplyRequestStatus;

  // org links (master-data ids)
  departmentId: string;
  workshopId?: string | null;
  sectionId?: string | null;

  // items
  items: SupplyRequestItem[];

  // attachments
  attachments?: FileRef[];

  // signatures / workflow
  signedByHead?: SupplyRequestSignature | null;
  approvedByDirector?: SupplyRequestSignature | null;
  acceptedBySupply?: SupplyRequestSignature | null;

  auditTrail?: SupplyRequestAuditTrailItem[];
};


