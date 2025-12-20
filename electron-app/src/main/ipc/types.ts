// Типы для IPC (renderer <-> main).

export type EngineListItem = {
  id: string;
  engineNumber?: string;
  engineBrand?: string;
  updatedAt: number;
  syncStatus: string;
};

export type EngineDetails = {
  id: string;
  typeId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
  attributes: Record<string, unknown>;
};

export type SyncRunResult = {
  ok: boolean;
  pushed: number;
  pulled: number;
  serverCursor: number;
  error?: string;
};


