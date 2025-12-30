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

export type EntityListItem = {
  id: string;
  typeId: string;
  updatedAt: number;
  syncStatus: string;
  displayName?: string;
};

export type EntityDetails = {
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

export type AppVersionResult = { ok: true; version: string } | { ok: false; error: string };

export type ServerHealthResult =
  | { ok: true; url: string; serverOk: boolean; version: string | null; buildDate: string | null }
  | { ok: false; url: string; error: string };

export type IncomingLinkInfo = {
  fromEntityId: string;
  fromEntityTypeId: string;
  fromEntityTypeCode: string;
  fromEntityTypeName: string;
  attributeDefId: string;
  attributeCode: string;
  attributeName: string;
  fromEntityDisplayName: string | null;
};

export type EntityDeleteInfoResult = { ok: true; links: IncomingLinkInfo[] } | { ok: false; error: string };

export type EntityDetachLinksAndDeleteResult = { ok: true; detached: number } | { ok: false; error: string };

export type EntityTypeDeleteInfoResult =
  | { ok: true; type: { id: string; code: string; name: string }; counts: { entities: number; defs: number } }
  | { ok: false; error: string };

export type EntityTypeDeleteResult = { ok: true; deletedEntities: number } | { ok: false; error: string };

export type AttributeDefDeleteInfoResult =
  | { ok: true; def: { id: string; entityTypeId: string; code: string; name: string; dataType: string; metaJson: string | null }; counts: { values: number } }
  | { ok: false; error: string };

export type AttributeDefDeleteResult = { ok: true } | { ok: false; error: string };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type AuthUserInfo = {
  id: string;
  username: string;
  role: string;
};

export type AuthStatus = {
  loggedIn: boolean;
  user: AuthUserInfo | null;
  permissions: Record<string, boolean> | null;
};

export type AuthLoginResult =
  | { ok: true; accessToken: string; refreshToken: string; user: AuthUserInfo; permissions: Record<string, boolean> }
  | { ok: false; error: string };

export type AuthLogoutResult = { ok: boolean; error?: string };

import type { RepairChecklistAnswers, RepairChecklistPayload, RepairChecklistTemplate } from '../domain/repairChecklist.js';
import type { SupplyRequestPayload, SupplyRequestStatus } from '../domain/supplyRequest.js';
import type { FileRef } from '../domain/fileStorage.js';

export type MatricaApi = {
  ping: () => Promise<{ ok: boolean; ts: number }>;
  app: {
    version: () => Promise<AppVersionResult>;
  };
  log: {
    send: (level: LogLevel, message: string) => Promise<void>;
  };
  logging: {
    getEnabled: () => Promise<boolean>;
    setEnabled: (enabled: boolean) => Promise<void>;
  };
  auth: {
    status: () => Promise<AuthStatus>;
    // Обновляет permissions по данным сервера (/auth/me) и сохраняет в локальную сессию.
    sync: () => Promise<AuthStatus>;
    login: (args: { username: string; password: string }) => Promise<AuthLoginResult>;
    logout: (args: { refreshToken?: string }) => Promise<AuthLogoutResult>;
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
  server: {
    health: () => Promise<ServerHealthResult>;
  };
  reports: {
    // CSV: “сколько двигателей на какой стадии” по состоянию на дату endMs.
    periodStagesCsv: (args: { startMs?: number; endMs: number }) => Promise<{ ok: true; csv: string } | { ok: false; error: string }>;
    // CSV: “стадии по группам” (заказчик/контракт/наряд) по link-атрибуту двигателя.
    periodStagesByLinkCsv: (args: { startMs?: number; endMs: number; linkAttrCode: string }) => Promise<
      { ok: true; csv: string } | { ok: false; error: string }
    >;
  };
  admin: {
    entityTypes: {
      list: () => Promise<{ id: string; code: string; name: string; updatedAt: number; deletedAt: number | null }[]>;
      upsert: (args: { id?: string; code: string; name: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
      deleteInfo: (entityTypeId: string) => Promise<EntityTypeDeleteInfoResult>;
      delete: (args: { entityTypeId: string; deleteEntities: boolean; deleteDefs: boolean }) => Promise<EntityTypeDeleteResult>;
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
      deleteInfo: (attributeDefId: string) => Promise<AttributeDefDeleteInfoResult>;
      delete: (args: { attributeDefId: string; deleteValues: boolean }) => Promise<AttributeDefDeleteResult>;
    };
    entities: {
      listByEntityType: (entityTypeId: string) => Promise<EntityListItem[]>;
      create: (entityTypeId: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
      get: (id: string) => Promise<EntityDetails>;
      setAttr: (entityId: string, code: string, value: unknown) => Promise<{ ok: boolean; error?: string }>;
      deleteInfo: (entityId: string) => Promise<EntityDeleteInfoResult>;
      detachLinksAndDelete: (entityId: string) => Promise<EntityDetachLinksAndDeleteResult>;
      softDelete: (entityId: string) => Promise<{ ok: boolean; error?: string }>;
    };
    users: {
      list: () => Promise<{ ok: true; users: { id: string; username: string; role: string; isActive: boolean }[] } | { ok: false; error: string }>;
      create: (args: { username: string; password: string; role: string }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
      update: (
        userId: string,
        args: { role?: string; isActive?: boolean; password?: string },
      ) => Promise<{ ok: boolean; error?: string }>;
      permissionsGet: (
        userId: string,
      ) => Promise<
        | {
            ok: true;
            user: { id: string; username: string; role: string };
            base: Record<string, boolean>;
            overrides: Record<string, boolean>;
            effective: Record<string, boolean>;
          }
        | { ok: false; error: string }
      >;
      permissionsSet: (userId: string, set: Record<string, boolean>) => Promise<{ ok: boolean; error?: string }>;

      delegationsList: (
        userId: string,
      ) => Promise<
        | {
            ok: true;
            delegations: {
              id: string;
              fromUserId: string;
              toUserId: string;
              permCode: string;
              startsAt: number;
              endsAt: number;
              note: string | null;
              createdAt: number;
              createdByUserId: string;
              revokedAt: number | null;
              revokedByUserId: string | null;
              revokeNote: string | null;
            }[];
          }
        | { ok: false; error: string }
      >;
      delegationCreate: (args: {
        fromUserId: string;
        toUserId: string;
        permCode: string;
        startsAt?: number;
        endsAt: number;
        note?: string;
      }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
      delegationRevoke: (args: { id: string; note?: string }) => Promise<{ ok: boolean; error?: string }>;
    };
  };
  update: {
    check: () => Promise<UpdateCheckResult>;
  };
  checklists: {
    templatesList: (args?: { stage?: string }) => Promise<
      | { ok: true; templates: RepairChecklistTemplate[] }
      | { ok: false; error: string }
    >;
    engineGet: (args: { engineId: string; stage: string }) => Promise<
      | { ok: true; operationId: string | null; payload: RepairChecklistPayload | null; templates: RepairChecklistTemplate[] }
      | { ok: false; error: string }
    >;
    engineSave: (args: {
      engineId: string;
      stage: string;
      templateId: string;
      operationId?: string | null;
      answers: RepairChecklistAnswers;
      attachments?: FileRef[];
    }) => Promise<{ ok: true; operationId: string } | { ok: false; error: string }>;
  };

  supplyRequests: {
    list: (args?: { q?: string; month?: string }) => Promise<
      | {
          ok: true;
          requests: {
            id: string;
            requestNumber: string;
            compiledAt: number;
            status: SupplyRequestStatus;
            title: string;
            departmentId: string;
            workshopId: string | null;
            sectionId: string | null;
            updatedAt: number;
          }[];
        }
      | { ok: false; error: string }
    >;
    get: (id: string) => Promise<{ ok: true; payload: SupplyRequestPayload } | { ok: false; error: string }>;
    create: () => Promise<{ ok: true; id: string; payload: SupplyRequestPayload } | { ok: false; error: string }>;
    update: (args: { id: string; payload: SupplyRequestPayload }) => Promise<{ ok: true } | { ok: false; error: string }>;
    delete: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    transition: (args: { id: string; action: string; note?: string | null }) => Promise<
      | { ok: true; payload: SupplyRequestPayload }
      | { ok: false; error: string }
    >;
  };

  parts: {
    list: (args?: { q?: string; limit?: number }) => Promise<
      | {
          ok: true;
          parts: Array<{
            id: string;
            name?: string;
            article?: string;
            updatedAt: number;
            createdAt: number;
          }>;
        }
      | { ok: false; error: string }
    >;
    get: (partId: string) => Promise<
      | {
          ok: true;
          part: {
            id: string;
            createdAt: number;
            updatedAt: number;
            attributes: Array<{
              id: string;
              code: string;
              name: string;
              dataType: string;
              value: unknown;
              isRequired: boolean;
              sortOrder: number;
              metaJson?: unknown;
            }>;
          };
        }
      | { ok: false; error: string }
    >;
    create: (args?: { attributes?: Record<string, unknown> }) => Promise<
      | {
          ok: true;
          part: { id: string; createdAt: number; updatedAt: number };
        }
      | { ok: false; error: string }
    >;
    createAttributeDef: (args: {
      code: string;
      name: string;
      dataType: 'text' | 'number' | 'boolean' | 'date' | 'json' | 'link';
      isRequired?: boolean;
      sortOrder?: number;
      metaJson?: string | null;
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    updateAttribute: (args: { partId: string; attributeCode: string; value: unknown }) => Promise<{ ok: true } | { ok: false; error: string }>;
    delete: (partId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    getFiles: (partId: string) => Promise<{ ok: true; files: unknown[] } | { ok: false; error: string }>;
  };

  files: {
    // Загружает файл на сервер (сервер сам решает: локально или Яндекс.Диск).
    upload: (args: { path: string; scope?: { ownerType: string; ownerId: string; category: string } }) => Promise<
      { ok: true; file: FileRef } | { ok: false; error: string }
    >;
    // Выбор файлов в OS-диалоге (для drag&drop можно не использовать).
    pick: () => Promise<{ ok: true; paths: string[] } | { ok: false; error: string }>;
    // Скачивает файл в локальную папку кеша (или выбранную пользователем) и возвращает путь.
    download: (args: { fileId: string }) => Promise<{ ok: true; localPath: string } | { ok: false; error: string }>;
    // Открывает файл (скачивает при необходимости) средствами ОС.
    open: (args: { fileId: string }) => Promise<{ ok: true; localPath: string } | { ok: false; error: string }>;
    // Удаляет файл на сервере (soft delete + удаление физического файла/объекта).
    delete: (args: { fileId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
    // Папка скачивания/кеша.
    downloadDirGet: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    downloadDirPick: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  };
};


