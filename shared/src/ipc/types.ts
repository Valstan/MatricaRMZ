// Общие типы IPC (используются и в Electron main, и в renderer).

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

export type OperationItem = {
  id: string;
  engineEntityId: string;
  operationType: string;
  status: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
};

export type AuditItem = {
  id: string;
  actor: string;
  action: string;
  entityId: string | null;
  tableName: string | null;
  payloadJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
};

export type SyncRunResult = {
  ok: boolean;
  pushed: number;
  pulled: number;
  serverCursor: number;
  error?: string;
};

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string }
  | { ok: false; error: string };

export type UpdateResult = { ok: boolean; error?: string };

export type MatricaApi = {
  ping: () => Promise<{ ok: boolean; ts: number }>;
  engines: {
    list: () => Promise<EngineListItem[]>;
    create: () => Promise<{ id: string }>;
    get: (id: string) => Promise<EngineDetails>;
    setAttr: (engineId: string, code: string, value: unknown) => Promise<void>;
  };
  operations: {
    list: (engineId: string) => Promise<OperationItem[]>;
    add: (engineId: string, operationType: string, status: string, note?: string) => Promise<void>;
  };
  audit: {
    list: () => Promise<AuditItem[]>;
  };
  sync: {
    run: () => Promise<SyncRunResult>;
  };
  update: {
    check: () => Promise<UpdateCheckResult>;
    download: () => Promise<UpdateResult>;
    install: () => Promise<UpdateResult>;
  };
};


