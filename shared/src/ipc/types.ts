// Общие типы IPC (используются и в Electron main, и в renderer).

export type EngineListItem = {
  id: string;
  engineNumber?: string;
  engineBrand?: string;
  engineBrandId?: string;
  customerId?: string;
  customerName?: string;
  contractId?: string;
  contractName?: string;
  arrivalDate?: number | null;
  shippingDate?: number | null;
  isScrap?: boolean;
  createdAt?: number;
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

export type ToolListItem = {
  id: string;
  toolNumber?: string;
  name?: string;
  serialNumber?: string;
  departmentId?: string | null;
  departmentName?: string | null;
  receivedAt?: number | null;
  retiredAt?: number | null;
  updatedAt: number;
  createdAt: number;
};

export type ToolDetails = {
  id: string;
  typeId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
  attributes: Record<string, unknown>;
};

export type ToolPropertyListItem = {
  id: string;
  name?: string;
  params?: string;
  updatedAt: number;
  createdAt: number;
};

export type ToolCatalogItem = {
  id: string;
  name?: string;
  updatedAt: number;
  createdAt: number;
};

export type ToolMovementItem = {
  id: string;
  toolId: string;
  movementAt: number;
  mode: 'received' | 'returned';
  employeeId?: string | null;
  confirmed: boolean;
  confirmedById?: string | null;
  comment?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type EmployeeListItem = {
  id: string;
  displayName?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  position?: string | null;
  departmentId?: string | null;
  departmentName?: string | null;
  employmentStatus?: string | null;
  accessEnabled?: boolean;
  systemRole?: string | null;
  deleteRequestedAt?: number | null;
  deleteRequestedById?: string | null;
  deleteRequestedByUsername?: string | null;
  personnelNumber?: string | null;
  updatedAt: number;
};

export type EmployeeAttributeDef = {
  id: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  metaJson: string | null;
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

export type AuditAddArgs = {
  // Code-like action, e.g. "ui.supply_request.edit_done"
  action: string;
  // Optional table/entity pointer (for debugging; UI can also encode these into payload).
  entityId?: string | null;
  tableName?: string | null;
  // Optional JSON payload with context (requestNumber, engineNumber, etc.)
  payload?: unknown;
};

export type AuditAddResult = { ok: true } | { ok: false; error: string };

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

export type SyncProgressEvent = {
  mode: 'force_full_pull';
  state: 'start' | 'progress' | 'done' | 'error';
  startedAt: number;
  elapsedMs: number;
  estimateMs: number | null;
  etaMs: number | null;
  progress: number | null;
  pulled?: number;
  error?: string;
};

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string; source?: 'github' | 'yandex' | 'lan'; downloadUrl?: string }
  | { ok: false; error: string };

export type UpdateRuntimeState = {
  state: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error';
  source?: 'github' | 'yandex' | 'lan';
  version?: string;
  progress?: number;
  message?: string;
  updatedAt: number;
};

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

export type AuthProfile = {
  id: string;
  login: string;
  role: string;
  fullName: string;
  chatDisplayName?: string | null;
  position: string;
  sectionId: string | null;
  sectionName: string | null;
};

export type AuthStatus = {
  loggedIn: boolean;
  user: AuthUserInfo | null;
  permissions: Record<string, boolean> | null;
};

export type ChatMessageType = 'text' | 'file' | 'deep_link';

export type ChatDeepLinkPayload = {
  kind: 'app_link';
  tab:
    | 'masterdata'
    | 'contracts'
    | 'contract'
    | 'changes'
    | 'engines'
    | 'engine'
    | 'requests'
    | 'request'
    | 'parts'
    | 'part'
    | 'tools'
    | 'tool'
    | 'tool_properties'
    | 'tool_property'
    | 'employees'
    | 'employee'
    | 'reports'
    | 'admin'
    | 'audit'
    | 'notes'
    | 'settings'
    | 'auth';
  engineId?: string | null;
  engineBrandId?: string | null;
  requestId?: string | null;
  partId?: string | null;
  toolId?: string | null;
  toolPropertyId?: string | null;
  contractId?: string | null;
  employeeId?: string | null;
  productId?: string | null;
  serviceId?: string | null;
  counterpartyId?: string | null;
  breadcrumbs?: string[];
};

export type ChatMessageItem = {
  id: string;
  senderUserId: string;
  senderUsername: string;
  recipientUserId: string | null;
  messageType: ChatMessageType;
  bodyText: string | null;
  payload: unknown | null;
  createdAt: number;
  updatedAt: number;
};

export type ChatUserItem = {
  id: string;
  username: string;
  chatDisplayName?: string | null;
  role: string;
  isActive: boolean;
  lastActivityAt: number | null;
  online: boolean;
};

export type ChatUsersListResult = { ok: true; users: ChatUserItem[] } | { ok: false; error: string };
export type ChatListResult = { ok: true; messages: ChatMessageItem[] } | { ok: false; error: string };
export type ChatSendResult = { ok: true; id: string } | { ok: false; error: string };
export type ChatUnreadCountResult =
  | { ok: true; total: number; global: number; byUser: Record<string, number> }
  | { ok: false; error: string };
export type ChatExportResult = { ok: true; path: string } | { ok: false; error: string };
export type ChatDeleteResult = { ok: true } | { ok: false; error: string };

export type NoteListResult = { ok: true; notes: NoteItem[]; shares: NoteShareItem[] } | { ok: false; error: string };
export type NoteUpsertResult = { ok: true; id: string } | { ok: false; error: string };
export type NoteDeleteResult = { ok: true } | { ok: false; error: string };
export type NoteShareResult = { ok: true } | { ok: false; error: string };

export type ReportBuilderOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in'
  | 'is_null'
  | 'not_null';

export type ReportBuilderFilterCondition = {
  kind: 'condition';
  column: string;
  operator: ReportBuilderOperator;
  value?: string | number | boolean | null | Array<string | number | boolean>;
};

export type ReportBuilderFilterGroup = {
  kind: 'group';
  op: 'and' | 'or';
  items: ReportBuilderFilter[];
};

export type ReportBuilderFilter = ReportBuilderFilterCondition | ReportBuilderFilterGroup;

export type ReportBuilderTableRequest = {
  name: string;
  filters?: ReportBuilderFilterGroup | null;
};

export type ReportBuilderPreviewRequest = {
  tables: ReportBuilderTableRequest[];
  limit?: number;
};

export type ReportBuilderColumnMeta = {
  id: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'json';
};

export type ReportBuilderPreviewTable = {
  name: string;
  label: string;
  columns: ReportBuilderColumnMeta[];
  rows: Array<Record<string, unknown>>;
};

export type ReportBuilderPreviewResult =
  | { ok: true; warning?: string | null; tables: ReportBuilderPreviewTable[] }
  | { ok: false; error: string };

export type ReportBuilderExportResult =
  | { ok: true; warning?: string | null; fileName: string; mime: string; contentBase64: string }
  | { ok: false; error: string };

export type AuthLoginResult =
  | { ok: true; accessToken: string; refreshToken: string; user: AuthUserInfo; permissions: Record<string, boolean> }
  | { ok: false; error: string };

export type AuthLogoutResult = { ok: boolean; error?: string };

export type ChangeRequestRow = {
  id: string;
  status: string;
  tableName: string;
  rowId: string;
  rootEntityId: string | null;
  beforeJson: string | null;
  afterJson: string;
  recordOwnerUserId: string | null;
  recordOwnerUsername: string | null;
  changeAuthorUserId: string;
  changeAuthorUsername: string;
  note: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedByUserId: string | null;
  decidedByUsername: string | null;
};

export type ChangesListResult = { ok: true; changes: ChangeRequestRow[] } | { ok: false; error: string };
export type ChangeDecisionResult = { ok: true } | { ok: false; error: string };

import type { RepairChecklistAnswers, RepairChecklistPayload, RepairChecklistTemplate } from '../domain/repairChecklist.js';
import type { SupplyRequestPayload, SupplyRequestStatus } from '../domain/supplyRequest.js';
import type { FileRef } from '../domain/fileStorage.js';
import type { NoteBlock, NoteImportance, NoteItem, NoteShareItem } from '../domain/notes.js';
import type {
  AiAgentAssistRequest,
  AiAgentAssistResponse,
  AiAgentLogRequest,
  AiAgentLogResponse,
  AiAgentOllamaHealthRequest,
  AiAgentOllamaHealthResponse,
} from '../domain/aiAgent.js';

export type MatricaApi = {
  ping: () => Promise<{ ok: boolean; ts: number }>;
  app: {
    version: () => Promise<AppVersionResult>;
  };
  log: {
    send: (level: LogLevel, message: string) => Promise<void>;
  };
  logging: {
    getConfig: () => Promise<{ ok: true; enabled: boolean; mode: 'dev' | 'prod' } | { ok: false; error: string }>;
    setEnabled: (enabled: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
    setMode: (mode: 'dev' | 'prod') => Promise<{ ok: true; mode: 'dev' | 'prod' } | { ok: false; error: string }>;
  };
  settings: {
    uiGet: (args?: {
      userId?: string;
    }) => Promise<
      | { ok: true; theme: string; chatSide: string; tabsLayout?: { order?: string[]; hidden?: string[]; trashIndex?: number | null } | null }
      | { ok: false; error: string }
    >;
    uiSet: (args: {
      theme?: string;
      chatSide?: string;
      userId?: string;
      tabsLayout?: { order?: string[]; hidden?: string[]; trashIndex?: number | null } | null;
    }) => Promise<
      | { ok: true; theme: string; chatSide: string; tabsLayout?: { order?: string[]; hidden?: string[]; trashIndex?: number | null } | null }
      | { ok: false; error: string }
    >;
  };
  e2eKeys: {
    status: () => Promise<{ ok: true; enabled: boolean; primaryPresent: boolean; previousCount: number; updatedAt: number } | { ok: false; error: string }>;
    export: () => Promise<{ ok: true; ring: { primary: string; previous: string[]; updatedAt: number } } | { ok: false; error: string }>;
    rotate: () => Promise<{ ok: true; ring: { primary: string; previous: string[]; updatedAt: number } } | { ok: false; error: string }>;
  };
  backups: {
    status: () => Promise<{ ok: true; mode: 'live' | 'backup'; backupDate: string | null } | { ok: false; error: string }>;
    nightlyList: () => Promise<
      | { ok: true; backups: Array<{ date: string; name: string; size: number | null; modified: string | null }> }
      | { ok: false; error: string }
    >;
    nightlyEnter: (args: { date: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
    nightlyRunNow: () => Promise<{ ok: true; startedAt: number } | { ok: false; error: string }>;
    exit: () => Promise<{ ok: true } | { ok: false; error: string }>;
  };
  auth: {
    status: () => Promise<AuthStatus>;
    // Обновляет permissions по данным сервера (/auth/me) и сохраняет в локальную сессию.
    sync: () => Promise<AuthStatus>;
    login: (args: { username: string; password: string }) => Promise<AuthLoginResult>;
    loginOptions: () => Promise<{ ok: true; rows: Array<{ login: string; fullName: string; role: string }> } | { ok: false; error: string }>;
    register: (args: { login: string; password: string; fullName: string; position: string }) => Promise<AuthLoginResult>;
    logout: (args: { refreshToken?: string }) => Promise<AuthLogoutResult>;
    changePassword: (args: { currentPassword: string; newPassword: string }) => Promise<{ ok: boolean; error?: string }>;
    profileGet: () => Promise<{ ok: true; profile: AuthProfile } | { ok: false; error: string }>;
    profileUpdate: (args: {
      fullName?: string | null;
      position?: string | null;
      sectionName?: string | null;
      chatDisplayName?: string | null;
    }) => Promise<{ ok: true; profile: AuthProfile } | { ok: false; error: string }>;
  };
  presence: {
    me: () => Promise<{ ok: true; online: boolean; lastActivityAt: number | null } | { ok: false; error: string }>;
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
    add: (args: AuditAddArgs) => Promise<AuditAddResult>;
  };
  sync: {
    run: () => Promise<SyncRunResult>;
    status: () => Promise<SyncStatus>;
    configGet: () => Promise<{ ok: boolean; apiBaseUrl?: string; error?: string }>;
    configSet: (args: { apiBaseUrl: string }) => Promise<{ ok: boolean; error?: string }>;
    reset: () => Promise<{ ok: boolean; error?: string }>;
    resetLocalDb: () => Promise<{ ok: boolean; restarting?: boolean; error?: string }>;
    onProgress?: (handler: (event: SyncProgressEvent) => void) => () => void;
  };
  changes: {
    list: (args?: { status?: string; limit?: number }) => Promise<ChangesListResult>;
    apply: (args: { id: string }) => Promise<ChangeDecisionResult>;
    reject: (args: { id: string }) => Promise<ChangeDecisionResult>;
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
    defectSupplyPreview: (args: { startMs?: number; endMs: number; contractIds?: string[] }) => Promise<
      | {
          ok: true;
          rows: Array<{ contractId: string; contractLabel: string; partName: string; partNumber: string; scrapQty: number; missingQty: number }>;
          totals: { scrapQty: number; missingQty: number };
          totalsByContract: Array<{ contractLabel: string; scrapQty: number; missingQty: number }>;
        }
      | { ok: false; error: string }
    >;
    defectSupplyPdf: (args: { startMs?: number; endMs: number; contractIds?: string[]; contractLabels: string[] }) => Promise<
      | { ok: true; contentBase64: string; fileName: string; mime: string }
      | { ok: false; error: string }
    >;
    defectSupplyPrint: (args: { startMs?: number; endMs: number; contractIds?: string[]; contractLabels: string[] }) => Promise<
      | { ok: true }
      | { ok: false; error: string }
    >;
  };
  reportsBuilder: {
    preview: (args: ReportBuilderPreviewRequest) => Promise<ReportBuilderPreviewResult>;
    export: (args: ReportBuilderPreviewRequest & { format: 'html' | 'xlsx' }) => Promise<ReportBuilderExportResult>;
    print: (args: ReportBuilderPreviewRequest & { htmlTitle?: string | null }) => Promise<{ ok: true } | { ok: false; error: string }>;
    exportPdf: (args: ReportBuilderPreviewRequest & { htmlTitle?: string | null }) => Promise<ReportBuilderExportResult>;
    meta: () => Promise<{ ok: true; tables: Array<{ name: string; label: string; columns: ReportBuilderColumnMeta[] }> } | { ok: false; error: string }>;
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
      list: () => Promise<
        | {
            ok: true;
            users: {
              id: string;
              username: string;
              login?: string;
              fullName?: string;
              role: string;
              isActive: boolean;
              deleteRequestedAt?: number | null;
              deleteRequestedById?: string | null;
              deleteRequestedByUsername?: string | null;
            }[];
          }
        | { ok: false; error: string }
      >;
      create: (args: {
        login: string;
        password: string;
        role: string;
        fullName?: string;
        accessEnabled?: boolean;
        employeeId?: string;
      }) => Promise<
        | { ok: true; id: string }
        | { ok: false; error: string }
      >;
      update: (
        userId: string,
        args: { role?: string; accessEnabled?: boolean; password?: string; login?: string; fullName?: string },
      ) => Promise<{ ok: boolean; error?: string }>;
      pendingApprove: (args: { pendingUserId: string; action: 'approve' | 'merge'; role?: 'user' | 'admin'; targetUserId?: string }) => Promise<
        | { ok: true }
        | { ok: false; error: string }
      >;
      permissionsGet: (
        userId: string,
      ) => Promise<
        | {
            ok: true;
            user: { id: string; username: string; login?: string; role: string; isActive?: boolean };
            allCodes?: string[];
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
      deleteRequest: (userId: string) => Promise<{ ok: boolean; error?: string }>;
      deleteConfirm: (userId: string) => Promise<{ ok: boolean; error?: string }>;
      deleteCancel: (userId: string) => Promise<{ ok: boolean; error?: string }>;
    };
  };
  employees: {
    list: () => Promise<EmployeeListItem[]>;
    get: (id: string) => Promise<EntityDetails>;
    create: () => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    setAttr: (employeeId: string, code: string, value: unknown) => Promise<{ ok: boolean; error?: string }>;
    delete: (employeeId: string) => Promise<{ ok: boolean; error?: string }>;
    merge: () => Promise<{ ok: true; stats?: any } | { ok: false; error: string }>;
    departmentsList: () => Promise<EntityListItem[]>;
    defs: () => Promise<EmployeeAttributeDef[]>;
    permissionsGet: (userId: string) => Promise<
      | {
          ok: true;
          user: { id: string; username: string; login?: string; role: string; isActive?: boolean };
          allCodes: string[];
          base: Record<string, boolean>;
          overrides: Record<string, boolean>;
          effective: Record<string, boolean>;
        }
      | { ok: false; error: string }
    >;
  };
  update: {
    check: () => Promise<UpdateCheckResult>;
    status: () => Promise<{ ok: true; status: UpdateRuntimeState } | { ok: false; error: string }>;
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
    list: (args?: { q?: string; limit?: number; engineBrandId?: string }) => Promise<
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
    updateAttribute: (args: { partId: string; attributeCode: string; value: unknown }) => Promise<
      { ok: true; queued?: boolean; changeRequestId?: string } | { ok: false; error: string }
    >;
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
    delete: (args: { fileId: string }) => Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }>;
    // Возвращает data: URL превью (thumbnail) либо null (если превью нет).
    previewGet: (args: { fileId: string }) => Promise<{ ok: true; dataUrl: string | null } | { ok: false; error: string }>;
    // Папка скачивания/кеша.
    downloadDirGet: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    downloadDirPick: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  };
  chat: {
    usersList: () => Promise<ChatUsersListResult>;
    list: (args: { mode: 'global' | 'private'; withUserId?: string | null; limit?: number }) => Promise<ChatListResult>;
    // Admin-only: list private dialog between any two users.
    adminListPair: (args: { userAId: string; userBId: string; limit?: number }) => Promise<ChatListResult>;
    sendText: (args: { recipientUserId?: string | null; text: string }) => Promise<ChatSendResult>;
    sendFile: (args: { recipientUserId?: string | null; path: string }) => Promise<ChatSendResult>;
    sendDeepLink: (args: { recipientUserId?: string | null; link: ChatDeepLinkPayload }) => Promise<ChatSendResult>;
    markRead: (args: { messageIds: string[] }) => Promise<{ ok: true; marked: number } | { ok: false; error: string }>;
    unreadCount: () => Promise<ChatUnreadCountResult>;
    export: (args: { startMs: number; endMs: number }) => Promise<ChatExportResult>;
    deleteMessage: (args: { messageId: string }) => Promise<ChatDeleteResult>;
  };
  notes: {
    list: () => Promise<NoteListResult>;
    upsert: (args: {
      id?: string;
      title: string;
      body: NoteBlock[];
      importance: NoteImportance;
      dueAt?: number | null;
      sortOrder?: number;
    }) => Promise<NoteUpsertResult>;
    delete: (args: { noteId: string }) => Promise<NoteDeleteResult>;
    share: (args: { noteId: string; recipientUserId: string }) => Promise<NoteShareResult>;
    unshare: (args: { noteId: string; recipientUserId: string }) => Promise<NoteShareResult>;
    hide: (args: { noteId: string; hidden: boolean }) => Promise<NoteShareResult>;
    reorder: (args: { noteId: string; sortOrder: number }) => Promise<NoteShareResult>;
    usersList: () => Promise<ChatUsersListResult>;
    burningCount: () => Promise<{ ok: true; count: number } | { ok: false; error: string }>;
  };
  aiAgent: {
    assist: (args: AiAgentAssistRequest) => Promise<AiAgentAssistResponse>;
    logEvent: (args: AiAgentLogRequest) => Promise<AiAgentLogResponse>;
    ollamaHealth: (args: AiAgentOllamaHealthRequest) => Promise<AiAgentOllamaHealthResponse>;
  };
};


