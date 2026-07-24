export type DefectReplenishmentMethod = 'purchase' | 'own_repair' | 'customer';

export type DefectConductLineInput = {
  sourceLineId: string;
  partId: string;
  partLabel: string;
  stampedNumber?: string;
  repairableQty: number;
  scrapQty: number;
  replaceQty: number;
  replenishmentMethod?: DefectReplenishmentMethod;
  defectDescription?: string;
};

export type DefectConductRequest = {
  operationId: string;
  engineId: string;
  draftRevision: string;
  lines: DefectConductLineInput[];
};

export type DefectPartEventType =
  | 'classified_repairable'
  | 'classified_scrap'
  | 'replacement_required'
  | 'sent_to_repair'
  | 'repaired'
  | 'purchase_requested'
  | 'purchased'
  | 'customer_requested'
  | 'customer_supplied'
  | 'issued_to_assembly'
  | 'returned_from_assembly'
  | 'written_off_again';

export type DefectPartHistoryEvent = {
  id: string;
  engineId: string;
  conductedVersionId: string;
  sourceLineId: string;
  nomenclatureId: string;
  instanceId: string | null;
  eventType: DefectPartEventType;
  qty: number;
  payload: Record<string, unknown> | null;
  occurredAt: number;
  occurredBy: string;
};

export type DefectConductedVersionSummary = {
  id: string;
  engineId: string;
  version: number;
  operationId: string;
  draftRevision: string;
  snapshotHash: string;
  documentHeaderId: string | null;
  status: 'active' | 'reversed';
  conductedAt: number;
  reversedAt: number | null;
};
