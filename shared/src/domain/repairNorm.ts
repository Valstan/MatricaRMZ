export const RepairNormSetStatus = {
  Draft: 'draft',
  Active: 'active',
  Archived: 'archived',
} as const;

export type RepairNormSetStatus = (typeof RepairNormSetStatus)[keyof typeof RepairNormSetStatus];

export type RepairNormLine = {
  id: string;
  normSetId: string;
  nomenclatureId: string;
  nomenclatureName: string;
  nomenclatureCode: string;
  qtyPerEngine: number;
  replacementPercent: number;
  groupName: string | null;
  sourceRowKey: string | null;
  sourceMeta: Record<string, unknown> | null;
  position: number;
};

export type RepairNormSetSummary = {
  id: string;
  name: string;
  version: number;
  status: RepairNormSetStatus;
  sourceKind: string | null;
  sourceKey: string | null;
  sourceImportedAt: number | null;
  sourceContentHash: string | null;
  notes: string | null;
  engineBrandIds: string[];
  lineCount: number;
  createdAt: number;
  updatedAt: number;
};

export type RepairNormSetDetails = RepairNormSetSummary & {
  lines: RepairNormLine[];
};

export type RepairNormSetInput = {
  id?: string;
  name: string;
  version?: number;
  status?: RepairNormSetStatus;
  sourceKind?: string | null;
  sourceKey?: string | null;
  sourceImportedAt?: number | null;
  sourceContentHash?: string | null;
  notes?: string | null;
  engineBrandIds: string[];
  lines: Array<{
    id?: string;
    nomenclatureId: string;
    qtyPerEngine: number;
    replacementPercent: number;
    groupName?: string | null;
    sourceRowKey?: string | null;
    sourceMeta?: Record<string, unknown> | null;
    position?: number;
  }>;
};
