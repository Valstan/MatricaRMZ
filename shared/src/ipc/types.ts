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
  performedAt: number | null;
  performedBy: string | null;
  metaJson: string | null;
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

export type SyncStatus = {
  state: 'idle' | 'syncing' | 'error';
  lastSyncAt: number | null;
  lastError: string | null;
  lastResult: SyncRunResult | null;
  nextAutoSyncInMs: number | null;
};

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string }
  | { ok: false; error: string };

export type UpdateResult = { ok: boolean; error?: string };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type MatricaApi = {
  ping: () => Promise<{ ok: boolean; ts: number }>;
  log: {
    send: (level: LogLevel, message: string) => Promise<void>;
  };
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
    status: () => Promise<SyncStatus>;
    configGet: () => Promise<{ ok: boolean; apiBaseUrl?: string; error?: string }>;
    configSet: (args: { apiBaseUrl: string }) => Promise<{ ok: boolean; error?: string }>;
  };
  reports: {
    // CSV: “сколько двигателей на какой стадии” по состоянию на дату endMs.
    periodStagesCsv: (args: { startMs?: number; endMs: number }) => Promise<{ ok: true; csv: string } | { ok: false; error: string }>;
  };
  admin: {
    entityTypes: {
      list: () => Promise<{ id: string; code: string; name: string; updatedAt: number; deletedAt: number | null }[]>;
      upsert: (args: { id?: string; code: string; name: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
    };
    attributeDefs: {
      listByEntityType: (entityTypeId: string) => Promise<
        {
          id: string;
          entityTypeId: string;
          code: string;
          name: string;
          dataType: string;
          isRequired: boolean;
          sortOrder: number;
          metaJson: string | null;
          updatedAt: number;
          deletedAt: number | null;
        }[]
      >;
      upsert: (args: {
        id?: string;
        entityTypeId: string;
        code: string;
        name: string;
        dataType: string;
        isRequired?: boolean;
        sortOrder?: number;
        metaJson?: string | null;
      }) => Promise<{ ok: boolean; id?: string; error?: string }>;
    };
  };
  update: {
    check: () => Promise<UpdateCheckResult>;
  };
};


