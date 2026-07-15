import type { GlobalSearchHit, GlobalSearchResponse } from '../domain/globalSearch.js';
import type { PartDimension, PartEngineBrandLink, PartMetadata, PartSpec } from '../domain/part.js';
import type { WorkshopStatsResult } from '../domain/workshopStats.js';
import type { TimesheetCodeDef, TimesheetData, TimesheetHeader } from '../domain/timesheet.js';
import type { UserUiProfile } from '../domain/userUiProfile.js';
import type { UiShellPrefs } from '../domain/uiShellV2.js';

// Общие типы IPC (используются и в Electron main, и в renderer).

export type EngineListItem = {
  id: string;
  engineNumber?: string;
  /** Внутренний номер из журнала дефектовки ('41'); уникален только в паре с годом. */
  internalNumber?: string;
  /** Год присвоения внутреннего номера (2026) — нумерация сбрасывается ежегодно. */
  internalNumberYear?: number;
  /**
   * Полный номер ('41/26') — денормализация РАДИ ПОИСКА: тир-1 сканирует поля строки,
   * а по отдельным '41' и '2026' запрос «41/26» не собирается (слэш нормализуется в пробел).
   * Считается в listEngines из пары выше, врозь разъехаться не может.
   */
  internalNumberFull?: string;
  engineBrand?: string;
  engineBrandId?: string;
  customerId?: string;
  customerName?: string;
  contractId?: string;
  contractName?: string;
  contractSectionNumber?: string;
  arrivalDate?: number | null;
  shippingDate?: number | null;
  isScrap?: boolean;
  /** Акт комплектности начат: хотя бы одна деталь в списке деталей отмечена «на месте». */
  hasCompletenessAct?: boolean;
  isReclamation?: boolean;
  isRepeatArrival?: boolean;
  isNumberCollision?: boolean;
  createdAt?: number;
  updatedAt: number;
  syncStatus: string;
  contractSignedAt?: number | null;
  statusFlags?: Partial<Record<StatusCode, boolean>>;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
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
  searchText?: string;
  price?: number;
};

export type DuplicateCandidate = {
  id: string;
  displayName: string;
  score: number;
  attributes: Record<string, unknown>;
};

export type EngineDuplicateCandidate = {
  id: string;
  engineNumber: string;
  engineBrand: string;
};

/** Двигатель, уже занявший пару (внутренний номер, год) — показывается как причина отказа. */
export type EngineInternalNumberDuplicate = {
  id: string;
  internalNumber: string;
  internalNumberYear: number;
  engineNumber: string;
  engineBrand: string;
};

/**
 * Proactive engine-number duplicate hint (#317). `exact` = same canonical key
 * (normalizeLookupCompact) — a real duplicate; `similar` = typo/near matches via
 * tiered search, shown only as «похожие», never as exact hits.
 */
export type EngineDuplicateMatches = {
  exact: EngineDuplicateCandidate[];
  similar: EngineDuplicateCandidate[];
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
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
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
  /** Имя сущности (инструмент / товар), если движение ведётся не только по инструментам. */
  subjectName?: string | null;
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
  workshopId?: string | null;
  employmentStatus?: string | null;
  terminationDate?: number | null;
  accessEnabled?: boolean;
  systemRole?: string | null;
  deleteRequestedAt?: number | null;
  deleteRequestedById?: string | null;
  deleteRequestedByUsername?: string | null;
  personnelNumber?: string | null;
  login?: string | null;
  sectionAccess?: Partial<Record<string, 'viewer' | 'editor'>>;
  updatedAt: number;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
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
  serverLastSeq?: number;
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
  mode: 'incremental' | 'force_full_pull';
  state: 'start' | 'progress' | 'done' | 'error';
  startedAt: number;
  elapsedMs: number;
  estimateMs: number | null;
  etaMs: number | null;
  progress: number | null;
  stage?: 'prepare' | 'push' | 'pull' | 'apply' | 'ledger' | 'finalize';
  /** Cold snapshot: UI-критичные таблицы (EAV-ядро + ERP) применены, хвост качается фоном. */
  coreReady?: boolean;
  service?: 'schema' | 'diagnostics' | 'ledger' | 'sync';
  detail?: string;
  table?: string;
  counts?: {
    total?: number;
    batch?: number;
  };
  breakdown?: {
    entityTypes?: Record<string, number>;
  };
  pulled?: number;
  error?: string;
};

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; version?: string; source?: 'github' | 'yandex' | 'lan' | 'torrent' | 'server'; downloadUrl?: string }
  | { ok: false; error: string };

export type UpdateRuntimeState = {
  state: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error';
  source?: 'github' | 'yandex' | 'lan' | 'torrent';
  version?: string;
  progress?: number;
  message?: string;
  updatedAt: number;
};

export type UpdateResult = { ok: boolean; error?: string };

export type AppVersionResult = { ok: true; version: string } | { ok: false; error: string };

export type ReleaseWelcomeGetResult =
  | {
      ok: true;
      shouldShow: boolean;
      currentVersion: string;
      previouslySeenVersion: string | null;
      welcome?: ReleaseWelcomeContent;
    }
  | { ok: false; error: string };

export type ReleaseWelcomeAcknowledgeResult =
  | { ok: true; version: string }
  | { ok: false; error: string };

export type ServerHealthResult =
  | { ok: true; url: string; serverOk: boolean; version: string | null; buildDate: string | null }
  | { ok: false; url: string; error: string };

export type DiagnosticsCriticalEventsListResult =
  | { ok: true; events: Array<Record<string, unknown>> }
  | { ok: false; error: string };

export type DiagnosticsCriticalEventDeleteResult =
  | { ok: true; deleted: boolean }
  | { ok: false; error: string };

export type DiagnosticsCriticalEventsClearResult =
  | { ok: true; deleted: number }
  | { ok: false; error: string };

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
  telegramLogin?: string | null;
  maxLogin?: string | null;
  position: string;
  sectionId: string | null;
  sectionName: string | null;
};

export type AuthStatus = {
  loggedIn: boolean;
  user: AuthUserInfo | null;
  permissions: Record<string, boolean> | null;
};

export type ChatMessageType = 'text' | 'file' | 'deep_link' | 'text_notify';

export type ChatDeepLinkPayload = {
  kind: 'app_link';
  tab:
    | 'history'
    | 'masterdata'
    | 'contracts'
    | 'contract'
    | 'counterparties'
    | 'counterparty'
    | 'changes'
    | 'engines'
    | 'engine_brands'
    | 'engine'
    | 'engine_brand'
    | 'requests'
    | 'request'
    | 'work_orders'
    | 'work_order'
    | 'parts'
    | 'part'
    | 'tools'
    | 'tool'
    | 'tool_properties'
    | 'tool_property'
    | 'employees'
    | 'employee'
    | 'products'
    | 'product'
    | 'services'
    | 'service'
    | 'nomenclature'
    | 'nomenclature_item'
    | 'stock_balances'
    | 'stock_receipts'
    | 'stock_issues'
    | 'stock_transfers'
    | 'stock_documents'
    | 'stock_document'
    | 'stock_inventory'
    | 'reports'
    | 'report_preset'
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
  nomenclatureId?: string | null;
  stockDocumentId?: string | null;
  workOrderId?: string | null;
  reportPresetId?: string | null;
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
export type ErpDictionaryListResult = { ok: true; rows: Array<Record<string, unknown>> } | { ok: false; error: string };
export type ErpCardListResult = { ok: true; rows: Array<Record<string, unknown>> } | { ok: false; error: string };
export type ErpUpsertResult = { ok: true; id: string } | { ok: false; error: string };
export type ErpDocumentListResult = { ok: true; rows: Array<Record<string, unknown>> } | { ok: false; error: string };

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
  | { ok: true; accessToken: string; refreshToken: string; user: AuthUserInfo; permissions: Record<string, boolean>; fullName?: string }
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

import type { EngineInventoryRow, RepairChecklistAnswers, RepairChecklistPayload, RepairChecklistTemplate } from '../domain/repairChecklist.js';
import type { EngineActType, EngineActVersionRecord } from '../domain/engineActSnapshot.js';
import type { PartStatusEventPayload } from '../domain/partStatusEvent.js';
import type { RepairFundInstancePayload, RepairFundRequirementVersionRecord } from '../domain/repairFundInstance.js';
import type { EngineRepairPartState } from '../domain/workOrder.js';
import type { SupplyRequestPayload, SupplyRequestStatus } from '../domain/supplyRequest.js';
import type { WorkOrderKind, WorkOrderPayload } from '../domain/workOrder.js';
import type {
  WorkOrderTemplateDto,
  WorkOrderTemplateLine,
  WorkOrderTemplateSummary,
} from '../domain/workOrderTemplate.js';
import type {
  EngineActTemplateDto,
  EngineActTemplatePayload,
  EngineActTemplateSummary,
} from '../domain/engineActTemplate.js';
import type { FileRef } from '../domain/fileStorage.js';
import type { NoteBlock, NoteImportance, NoteItem, NoteShareItem } from '../domain/notes.js';
import type { StatusCode } from '../domain/contract.js';
import type { UiControlSettings } from '../domain/uiControl.js';
import type { ReleaseWelcomeContent } from '../domain/releaseWelcome.js';
import type { AnalyticsBucket, EngineOutputMetric, EngineOutputResult } from '../domain/analytics.js';
import type {
  ReportPreset1cXmlResult,
  ReportPresetCsvResult,
  ReportPresetFavoritesResult,
  ReportPresetFilterTemplateSaveResult,
  ReportPresetFilterTemplatesListResult,
  ReportPresetFilters,
  ReportPresetHistoryAddResult,
  ReportPresetId,
  ReportPresetHistoryEntry,
  ReportPresetHistoryListResult,
  ReportPresetListResult,
  ReportPresetPdfResult,
  ReportPresetPreviewRequest,
  ReportPresetPreviewResult,
  ReportPresetPrintResult,
} from '../domain/reports.js';
import type {
  AiAgentAssistRequest,
  AiAgentAssistResponse,
  AiAgentConversationDeleteResponse,
  AiAgentConversationMessagesResponse,
  AiAgentConversationSearchResponse,
  AiAgentConversationsListResponse,
  AiAgentLogRequest,
  AiAgentLogResponse,
  AiAgentStreamEvent,
} from '../domain/aiAgent.js';
import type {
  EngineAssemblyBomDetails,
  WarehouseBomRelationTypeUsage,
  WarehouseBomRelationSchema,
  EngineAssemblyBomExpandedRow,
  EngineAssemblyBomListItem,
  EngineAssemblyBomUpsertInput,
  EngineInstanceListItem,
  EngineInstanceStatus,
  NomenclatureItemType,
  WarehouseDocumentDetails,
  WarehouseDocumentListItem,
  WarehouseDocumentType,
  WarehouseDocumentUpsertInput,
  WarehouseForecastIncomingFilter,
  WarehouseForecastIncomingRow,
  WarehouseLookups,
  WarehouseMovementListItem,
  WarehouseNomenclatureListItem,
  WarehouseStockListItem,
} from '../domain/warehouse.js';

/** Operator-built screen (UI builder): EAV `ui_screen`, factory-wide synced. */
export type UiScreenListItem = {
  id: string;
  name: string;
  sectionId: string;
  createdBy: string;
  updatedAt: number;
  /** Whether the CURRENT viewer may edit/delete (editor of the screen's section). */
  canEdit: boolean;
};

export type UiScreenDetails = UiScreenListItem & { specJson: string };

export type MatricaApi = {
  ping: () => Promise<{ ok: boolean; ts: number }>;
  app: {
    version: () => Promise<AppVersionResult>;
    onCloseRequest?: (handler: () => void) => () => void;
    respondToCloseRequest?: (args: { allowClose: boolean }) => void;
    navigateDeepLink?: (link: ChatDeepLinkPayload) => Promise<{ ok: boolean; error?: string }>;
    onDeepLink?: (handler: (link: ChatDeepLinkPayload) => void) => () => void;
  };
  search: {
    global: (args: { q: string; limit?: number }) => Promise<GlobalSearchResponse>;
    cardContent: (args: { entityIds: string[]; q: string }) => Promise<{ ok: true; ids: string[] } | { ok: false; error: string }>;
    // Двигатели по НАБИТОМУ на детали номеру («№ на детали», не сборочный) из списка деталей карточки.
    enginesByStampedNumber: (args: { q: string; limit?: number }) => Promise<
      { ok: true; hits: GlobalSearchHit[] } | { ok: false; error: string }
    >;
  };
  activity: {
    report: (args: { activeDate: string; activeMs: number }) => void;
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
      | {
          ok: true;
          theme: string;
          chatSide: string;
          enterAsTab?: boolean;
          tabsLayout?: {
            order?: string[];
            hidden?: string[];
            trashIndex?: number | null;
            groupOrder?: string[];
            hiddenGroups?: string[];
            collapsedGroups?: string[];
            activeGroup?: string | null;
          } | null;
          shellPrefs?: UiShellPrefs | null;
        }
      | { ok: false; error: string }
    >;
    uiSet: (args: {
      theme?: string;
      chatSide?: string;
      enterAsTab?: boolean;
      userId?: string;
      tabsLayout?: {
        order?: string[];
        hidden?: string[];
        trashIndex?: number | null;
        groupOrder?: string[];
        hiddenGroups?: string[];
        collapsedGroups?: string[];
        activeGroup?: string | null;
      } | null;
      shellPrefs?: UiShellPrefs | null;
    }) => Promise<
      | {
          ok: true;
          theme: string;
          chatSide: string;
          enterAsTab?: boolean;
          tabsLayout?: {
            order?: string[];
            hidden?: string[];
            trashIndex?: number | null;
            groupOrder?: string[];
            hiddenGroups?: string[];
            collapsedGroups?: string[];
            activeGroup?: string | null;
          } | null;
          shellPrefs?: UiShellPrefs | null;
        }
      | { ok: false; error: string }
    >;
    uiControlGet: () => Promise<
      | {
          ok: true;
          uiDefaultsVersion: number;
          globalDefaults: UiControlSettings;
          effective: UiControlSettings;
        }
      | { ok: false; error: string }
    >;
    uiControlSetGlobal: (args: { uiSettings: UiControlSettings; bumpVersion?: boolean }) => Promise<
      | { ok: true; uiDefaultsVersion: number; globalDefaults: UiControlSettings }
      | { ok: false; error: string }
    >;
    releaseWelcomeGet: () => Promise<ReleaseWelcomeGetResult>;
    releaseWelcomeAcknowledge: () => Promise<ReleaseWelcomeAcknowledgeResult>;
  };
  uiScreens: {
    list: () => Promise<{ ok: true; rows: UiScreenListItem[] } | { ok: false; error: string }>;
    get: (id: string) => Promise<{ ok: true; screen: UiScreenDetails } | { ok: false; error: string }>;
    save: (args: {
      id?: string;
      name: string;
      sectionId: string;
      specJson: string;
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    delete: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  };
  shortcuts: {
    get: (args: { userId: string }) => Promise<{ ok: true; ids: string[] } | { ok: false; error: string }>;
    set: (args: { userId: string; ids: string[] }) => Promise<{ ok: true; ids: string[] } | { ok: false; error: string }>;
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
    loginSuggest: (args: { q: string }) => Promise<{ ok: true; rows: Array<{ login: string; fullName: string }> } | { ok: false; error: string }>;
    // Machine-local MRU of recent login names (userData file, survives DB reset).
    loginMru: () => Promise<{ ok: true; logins: string[]; entries?: Array<{ login: string; fullName?: string; lastAt: number }> }>;
    register: (args: { login: string; password: string; fullName: string; position: string }) => Promise<AuthLoginResult>;
    logout: (args: { refreshToken?: string }) => Promise<AuthLogoutResult>;
    changePassword: (args: { currentPassword: string; newPassword: string }) => Promise<{ ok: boolean; error?: string }>;
    profileGet: () => Promise<{ ok: true; profile: AuthProfile } | { ok: false; error: string }>;
    profileUpdate: (args: {
      fullName?: string | null;
      position?: string | null;
      sectionName?: string | null;
      chatDisplayName?: string | null;
      telegramLogin?: string | null;
      maxLogin?: string | null;
    }) => Promise<{ ok: true; profile: AuthProfile } | { ok: false; error: string }>;
    // Workspace-профиль (вкладки/ярлыки/Мой Круг), серверный, подгружается при логине.
    uiProfileGet: () => Promise<{ ok: true; profile: UserUiProfile | null } | { ok: false; error: string }>;
    uiProfileSet: (args: { profile: UserUiProfile }) => Promise<{ ok: true; profile: UserUiProfile; stale: boolean } | { ok: false; error: string }>;
  };
  presence: {
    me: () => Promise<{ ok: true; online: boolean; lastActivityAt: number | null } | { ok: false; error: string }>;
  };
  engines: {
    list: () => Promise<EngineListItem[]>;
    create: () => Promise<{ id: string }>;
    get: (id: string) => Promise<EngineDetails>;
    setAttr: (engineId: string, code: string, value: unknown) => Promise<void>;
    advanceStatus: (args: {
      engineId: string;
      target: 'status_repair_started' | 'status_repaired';
      dateMs: number;
    }) => Promise<{ applied: boolean; reason?: string }>;
    findDuplicateCandidates: (args: { engineNumber: string; excludeEngineId?: string }) => Promise<EngineDuplicateMatches>;
    findInternalNumberDuplicate: (args: {
      internalNumber: string;
      internalNumberYear: number;
      excludeEngineId?: string;
    }) => Promise<EngineInternalNumberDuplicate | null>;
  };
  operations: {
    list: (engineId: string) => Promise<OperationItem[]>;
    add: (engineId: string, operationType: string, status: string, note?: string, metaJson?: string | null) => Promise<void>;
  };
  audit: {
    list: () => Promise<AuditItem[]>;
    add: (args: AuditAddArgs) => Promise<AuditAddResult>;
  };
  sync: {
    run: () => Promise<SyncRunResult>;
    fullPull: () => Promise<SyncRunResult>;
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
  diagnostics: {
    criticalEventsList: (args?: { days?: number; limit?: number }) => Promise<DiagnosticsCriticalEventsListResult>;
    criticalEventsDelete: (args: { id: string }) => Promise<DiagnosticsCriticalEventDeleteResult>;
    criticalEventsClear: () => Promise<DiagnosticsCriticalEventsClearResult>;
  };
  reports: {
    presetList: () => Promise<ReportPresetListResult>;
    presetPreview: (args: ReportPresetPreviewRequest) => Promise<ReportPresetPreviewResult>;
    presetPdf: (args: ReportPresetPreviewRequest) => Promise<ReportPresetPdfResult>;
    presetCsv: (args: ReportPresetPreviewRequest) => Promise<ReportPresetCsvResult>;
    preset1cXml: (args: ReportPresetPreviewRequest) => Promise<ReportPreset1cXmlResult>;
    presetPrint: (args: ReportPresetPreviewRequest) => Promise<ReportPresetPrintResult>;
    favoritesGet: (args?: { userId?: string }) => Promise<ReportPresetFavoritesResult>;
    favoritesSet: (args: { userId?: string; ids: string[] }) => Promise<ReportPresetFavoritesResult>;
    historyList: (args?: { userId?: string; limit?: number }) => Promise<ReportPresetHistoryListResult>;
    historyAdd: (args: { userId?: string; entry: ReportPresetHistoryEntry }) => Promise<ReportPresetHistoryAddResult>;
    filterTemplatesList: (args: { userId?: string; presetId: ReportPresetId }) => Promise<ReportPresetFilterTemplatesListResult>;
    filterTemplateSave: (args: {
      userId?: string;
      presetId: ReportPresetId;
      template: { id?: string; name: string; filters: ReportPresetFilters; disabled: string[] };
    }) => Promise<ReportPresetFilterTemplateSaveResult>;
    filterTemplateDelete: (args: {
      userId?: string;
      presetId: ReportPresetId;
      templateId: string;
    }) => Promise<ReportPresetFilterTemplateSaveResult>;
    // CSV: “сколько двигателей на какой стадии” по состоянию на дату endMs.
    periodStagesCsv: (args: { startMs?: number; endMs: number }) => Promise<{ ok: true; csv: string } | { ok: false; error: string }>;
    // CSV: “стадии по группам” (заказчик/контракт/наряд) по link-атрибуту двигателя.
    periodStagesByLinkCsv: (args: { startMs?: number; endMs: number; linkAttrCode: string }) => Promise<
      { ok: true; csv: string } | { ok: false; error: string }
    >;
    defectSupplyPreview: (args: {
      startMs?: number;
      endMs: number;
      contractIds?: string[];
      brandIds?: string[];
      includePurchases?: boolean;
    }) => Promise<
      | {
          ok: true;
          rows: Array<{ contractId: string; contractLabel: string; partName: string; partNumber: string; scrapQty: number; missingQty: number }>;
          totals: { scrapQty: number; missingQty: number };
          totalsByContract: Array<{ contractLabel: string; scrapQty: number; missingQty: number }>;
        }
      | { ok: false; error: string }
    >;
    defectSupplyPdf: (args: {
      startMs?: number;
      endMs: number;
      contractIds?: string[];
      contractLabels: string[];
      brandIds?: string[];
      includePurchases?: boolean;
    }) => Promise<
      | { ok: true; contentBase64: string; fileName: string; mime: string }
      | { ok: false; error: string }
    >;
    defectSupplyPrint: (args: {
      startMs?: number;
      endMs: number;
      contractIds?: string[];
      contractLabels: string[];
      brandIds?: string[];
      includePurchases?: boolean;
    }) => Promise<
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
      // fallbackTypeId (deferred-create): a not-yet-saved card has no row — passing the type
      // synthesizes an empty card on get and materializes the row on the first setAttr.
      get: (id: string, fallbackTypeId?: string) => Promise<EntityDetails>;
      setAttr: (entityId: string, code: string, value: unknown, fallbackTypeId?: string) => Promise<{ ok: boolean; error?: string }>;
      findDuplicates: (args: { entityTypeId: string; query: { name?: string; article?: string; price?: number }; excludeEntityId?: string }) => Promise<DuplicateCandidate[]>;
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
    audit: {
      list: (args?: { limit?: number; fromMs?: number; toMs?: number; actor?: string; actionType?: 'create' | 'update' | 'delete' | 'session' | 'other' }) => Promise<
        | {
            ok: true;
            rows: Array<{
              id: string;
              createdAt: number;
              actor: string;
              action: string;
              actionType: 'create' | 'update' | 'delete' | 'session' | 'other';
              section: string;
              actionText: string;
              documentLabel: string;
              clientId: string | null;
              tableName: string | null;
              entityId: string | null;
            }>;
          }
        | { ok: false; error: string }
      >;
      dailySummary: (args?: { date?: string; cutoffHour?: number }) => Promise<
        | {
            ok: true;
            rangeStart: number;
            rangeEnd: number;
            cutoffHour: number;
            rows: Array<{
              login: string;
              fullName: string;
              onlineMs: number;
              onlineHours: number;
              created: number;
              updated: number;
              deleted: number;
              totalChanged: number;
            }>;
          }
        | { ok: false; error: string }
      >;
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
  timesheets: {
    codes: () => Promise<{ ok: true; codes: TimesheetCodeDef[] } | { ok: false; error: string }>;
    departments: () => Promise<{ ok: true; rows: Array<{ id: string; name: string }> } | { ok: false; error: string }>;
    list: (args?: { workshopId?: string; departmentId?: string; year?: number }) => Promise<{ ok: true; rows: TimesheetHeader[] } | { ok: false; error: string }>;
    get: (id: string) => Promise<{ ok: true; timesheet: TimesheetData } | { ok: false; error: string }>;
    create: (args: { workshopId?: string; departmentId?: string; year: number; month: number; weekMode?: 5 | 6; shiftHours?: number }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    update: (args: { id: string; status?: 'draft' | 'closed'; weekMode?: 5 | 6; normHours?: number | null; allowOthersEdit?: boolean }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    delete: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    addRows: (args: { timesheetId: string; employees: Array<{ employeeId: string; tabNumber?: string | null; position?: string | null }> }) => Promise<{ ok: true; added: number } | { ok: false; error: string }>;
    removeRow: (rowId: string) => Promise<{ ok: true; rowId: string } | { ok: false; error: string }>;
    setCells: (args: { rowId: string; cells: Array<{ day: number; code?: string | null; hours?: number | null; comment?: string | null }> }) => Promise<{ ok: true; written: number } | { ok: false; error: string }>;
  };
  update: {
    check: () => Promise<UpdateCheckResult>;
    status: () => Promise<{ ok: true; status: UpdateRuntimeState } | { ok: false; error: string }>;
    reset: () => Promise<{ ok: true } | { ok: false; error: string }>;
    downloadDirGet: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    downloadDirPick: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
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
    /** Ф2: зафиксировать версию акта (комплектности/дефектовки) при печати. Дедуп идентичных подряд. */
    engineActSnapshot: (args: {
      engineId: string;
      actType: EngineActType;
      rows: EngineInventoryRow[];
      header: { engineBrand: string; engineNumber: string; contractNumber: string; engineInternalNumber?: string };
      answers: RepairChecklistAnswers;
      selectedCount: number;
    }) => Promise<
      | { ok: true; operationId: string; version: number; deduped: boolean }
      | { ok: false; error: string }
    >;
    /** Ф2: история версий акта по двигателю (новые сверху). */
    engineActVersions: (args: { engineId: string; actType: EngineActType }) => Promise<
      | { ok: true; versions: EngineActVersionRecord[] }
      | { ok: false; error: string }
    >;
    /** Ф5 (GAP-6): история статусов деталей двигателя (события part_status_event, новые сверху). */
    enginePartStatusEvents: (args: { engineId: string }) => Promise<
      | { ok: true; events: Array<PartStatusEventPayload & { operationId: string; at: number; by: string }> }
      | { ok: false; error: string }
    >;
    /** Ремфонд Ф3: номерные экземпляры деталей двигателя (личные набитые номера). */
    engineStampedInstances: (args: { engineId: string }) => Promise<
      | { ok: true; instances: Array<RepairFundInstancePayload & { operationId: string; at: number }> }
      | { ok: false; error: string }
    >;
    /** Ремфонд Ф4: версии печатного «требования к заказчику» (новые сверху). */
    requirementVersions: (args: { engineId: string }) => Promise<
      | { ok: true; versions: RepairFundRequirementVersionRecord[] }
      | { ok: false; error: string }
    >;
    /** Ремфонд Ф4: сохранить снимок требования (печать = новая версия, дедуп идентичных). */
    requirementSnapshot: (args: {
      engineId: string;
      instances: RepairFundInstancePayload[];
      header: { engineBrand: string; engineNumber: string; contractNumber: string; engineInternalNumber?: string };
    }) => Promise<{ ok: true; operationId: string; version: number; deduped: boolean } | { ok: false; error: string }>;
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
                sentAt?: number | null;
                arrivedAt?: number | null;
            title: string;
                itemsCount: number;
            departmentId: string;
            workshopId: string | null;
            sectionId: string | null;
            updatedAt: number;
            attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
          }[];
        }
      | { ok: false; error: string }
    >;
    get: (id: string) => Promise<{ ok: true; payload: SupplyRequestPayload } | { ok: false; error: string }>;
    create: () => Promise<{ ok: true; id: string; payload: SupplyRequestPayload } | { ok: false; error: string }>;
    update: (args: { id: string; payload: SupplyRequestPayload }) => Promise<{ ok: true; requestNumber: string } | { ok: false; error: string }>;
    delete: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    transition: (args: { id: string; action: string; note?: string | null }) => Promise<
      | { ok: true; payload: SupplyRequestPayload }
      | { ok: false; error: string }
    >;
  };
  workOrders: {
    list: (args?: { q?: string; month?: string }) => Promise<
      | {
          ok: true;
          rows: Array<{
            id: string;
            workOrderNumber: number;
            orderDate: number;
            startDate: number | null;
            workType: string;
            crewCount: number;
            performerSurnames: string;
            totalAmountRub: number;
            updatedAt: number;
            status: string;
            linkedDocumentId: string | null;
            dueDate: number | null;
            completedAt: number | null;
            engineBrand: string;
            engineNumber: string;
            acceptedByEmployeeId: string | null;
          }>;
        }
      | { ok: false; error: string }
    >;
    get: (id: string) => Promise<
      | { ok: true; payload: WorkOrderPayload; status: string; updatedAt: number }
      | { ok: false; error: string }
    >;
    activeAssemblyVariant: (engineId: string) => Promise<
      | { ok: true; variantGroup: string | null }
      | { ok: false; error: string }
    >;
    create: () => Promise<{ ok: true; id: string; payload: WorkOrderPayload } | { ok: false; error: string }>;
    update: (args: { id: string; payload: WorkOrderPayload }) => Promise<{ ok: true; workOrderNumber: number } | { ok: false; error: string }>;
    delete: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    close: (args: { operationId: string; expectedUpdatedAt?: number }) => Promise<
      | { ok: true; operationId: string; documentId: string | null; posted: boolean; updatedAt: number }
      | { ok: false; error: string }
    >;
    saveAssemblyDraft: (args: { operationId: string; expectedUpdatedAt?: number }) => Promise<
      | { ok: true; operationId: string; documentId: string; reserved: boolean; updatedAt: number }
      | { ok: false; error: string }
    >;
    postAssembly: (args: { operationId: string; expectedUpdatedAt?: number }) => Promise<
      | { ok: true; operationId: string; documentId: string; posted: boolean; updatedAt: number }
      | { ok: false; error: string }
    >;
    deleteAssemblyDraft: (args: { operationId: string; expectedUpdatedAt?: number }) => Promise<
      | { ok: true; operationId: string; updatedAt: number }
      | { ok: false; error: string }
    >;
    createAssemblyFromForecast: (args: {
      variantKey: string;
      brandId: string;
      engineBrandName?: string;
      /** Phase 2.4 PR 1: каждая required-part строка может опционально нести предлагаемый склад
       * (warehouse_locations.id, uuid). Если задан — попадает в line.sourceWarehouseId нового наряда. */
      requiredParts: Array<{ partId: string; qty: number; partLabel: string; sourceWarehouseId?: string }>;
      /** v1.29.2 followup: если прогноз построен с `assemblyForecastOnSiteOnly`, строка варианта
       * уже привязана к конкретному двигателю в ремонте — он пробрасывается в наряд. */
      engineId?: string;
      engineNumber?: string;
    }) => Promise<
      | { ok: true; id: string; workOrderNumber: number }
      | { ok: false; error: string }
    >;
    assemblyReturn: (args: {
      engineId: string;
      reason?: string | null;
      /** Операционная дата документа (учёт «задним числом»); по умолчанию — сейчас. */
      docDate?: number;
      lines: Array<{ nomenclatureId: string; qty: number; mode: 'rework' | 'scrap' }>;
    }) => Promise<
      { ok: true; documentId: string; posted: boolean; docNo?: string; docDate?: number } | { ok: false; error: string }
    >;
    /** Что сейчас «в сборке» по двигателю (для диалога возврата: prefill + проверка «не больше, чем списано»). */
    assemblyInProgress: (
      engineId: string,
    ) => Promise<
      | { ok: true; rows: Array<{ nomenclatureId: string; name: string | null; code: string | null; qty: number }> }
      | { ok: false; error: string }
    >;
    /** Ф5 (GAP-4 вход): черновик Repair-наряда из строк дефектовки «свой ремонт». */
    createRepairFromDefects: (args: {
      engineId: string;
      engineNumber?: string;
      engineBrandId?: string;
      engineBrandName?: string;
      items: Array<{ partId: string; qty: number; partLabel: string }>;
    }) => Promise<
      | { ok: true; id: string; workOrderNumber: number }
      | { ok: false; error: string }
    >;
    /** Ф5 (GAP-4): производные статусы «в ремонте/готова к сборке» по деталям двигателя (key = partId). */
    engineRepairPartStates: (engineId: string) => Promise<
      | { ok: true; states: Record<string, EngineRepairPartState> }
      | { ok: false; error: string }
    >;
  };

  workOrderTemplates: {
    list: (args?: { kind?: WorkOrderKind }) => Promise<
      | { ok: true; templates: WorkOrderTemplateSummary[] }
      | { ok: false; error: string }
    >;
    get: (id: string) => Promise<
      | { ok: true; template: WorkOrderTemplateDto }
      | { ok: false; error: string }
    >;
    create: (args: {
      workOrderKind: WorkOrderKind;
      name: string;
      payloadOverrides?: Record<string, unknown>;
      hiddenFields?: string[];
      lines?: WorkOrderTemplateLine[];
    }) => Promise<
      | { ok: true; template: WorkOrderTemplateDto }
      | { ok: false; error: string }
    >;
    update: (args: {
      id: string;
      name?: string;
      payloadOverrides?: Record<string, unknown>;
      hiddenFields?: string[];
      lines?: WorkOrderTemplateLine[];
    }) => Promise<
      | { ok: true; template: WorkOrderTemplateDto }
      | { ok: false; error: string }
    >;
    delete: (id: string) => Promise<
      | { ok: true; deleted: true }
      | { ok: false; error: string }
    >;
  };

  engineActTemplates: {
    list: (args?: { engineBrandId?: string }) => Promise<
      | { ok: true; templates: EngineActTemplateSummary[] }
      | { ok: false; error: string }
    >;
    get: (id: string) => Promise<
      | { ok: true; template: EngineActTemplateDto }
      | { ok: false; error: string }
    >;
    create: (args: { engineBrandId: string; name: string; payload?: EngineActTemplatePayload }) => Promise<
      | { ok: true; template: EngineActTemplateDto }
      | { ok: false; error: string }
    >;
    update: (args: { id: string; name?: string; payload?: EngineActTemplatePayload }) => Promise<
      | { ok: true; template: EngineActTemplateDto }
      | { ok: false; error: string }
    >;
    delete: (id: string) => Promise<
      | { ok: true; deleted: true }
      | { ok: false; error: string }
    >;
  };

  signatureCaptions: {
    list: () => Promise<{ ok: true; captions: string[] } | { ok: false; error: string }>;
    add: (args: { text: string }) => Promise<
      | { ok: true; added: boolean }
      | { ok: false; error: string }
    >;
  };

  workshops: {
    list: (args?: { activeOnly?: boolean }) => Promise<
      | {
          ok: true;
          rows: Array<{
            id: string;
            code: string;
            name: string;
            isActive: boolean;
            displayOrder: number;
            deprecatedAt: number | null;
            metadataJson: string | null;
            createdAt: number;
            updatedAt: number;
          }>;
        }
      | { ok: false; error: string }
    >;
    stats: (args?: { from?: string; to?: string; workshopId?: string }) => Promise<
      { ok: true; result: WorkshopStatsResult } | { ok: false; error: string }
    >;
    upsert: (args: {
      id?: string;
      code: string;
      name: string;
      isActive?: boolean;
      displayOrder?: number;
      metadataJson?: string | null;
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    delete: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    getRepairTemplate: (workshopId: string) => Promise<
      | {
          ok: true;
          template: {
            workshopId: string;
            lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
            updatedAt: number | null;
            updatedBy: string | null;
          };
        }
      | { ok: false; error: string }
    >;
    setRepairTemplate: (args: {
      workshopId: string;
      lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
    }) => Promise<{ ok: true; workshopId: string; lineCount: number } | { ok: false; error: string }>;
    listRepairTemplates: (workshopId: string) => Promise<
      | {
          ok: true;
          templates: Array<{
            id: string;
            workshopId: string;
            name: string;
            lineCount: number;
            updatedAt: number | null;
          }>;
        }
      | { ok: false; error: string }
    >;
    getRepairTemplateById: (args: { workshopId: string; templateId: string }) => Promise<
      | {
          ok: true;
          template: {
            id: string;
            workshopId: string;
            name: string;
            lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
            updatedAt: number | null;
            updatedBy: string | null;
          };
        }
      | { ok: false; error: string }
    >;
    createRepairTemplate: (args: {
      workshopId: string;
      name: string;
      lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
    }) => Promise<
      | {
          ok: true;
          template: {
            id: string;
            workshopId: string;
            name: string;
            lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
            updatedAt: number | null;
            updatedBy: string | null;
          };
        }
      | { ok: false; error: string }
    >;
    updateRepairTemplate: (args: {
      workshopId: string;
      templateId: string;
      name?: string;
      lines?: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
    }) => Promise<
      | {
          ok: true;
          template: {
            id: string;
            workshopId: string;
            name: string;
            lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
            updatedAt: number | null;
            updatedBy: string | null;
          };
        }
      | { ok: false; error: string }
    >;
    deleteRepairTemplate: (args: { workshopId: string; templateId: string }) => Promise<
      { ok: true; id: string } | { ok: false; error: string }
    >;
  };

  warehouseLocations: {
    list: (args?: { type?: 'system' | 'workshop' | 'regular'; activeOnly?: boolean }) => Promise<
      | {
          ok: true;
          rows: Array<{
            id: string;
            type: 'system' | 'workshop' | 'regular';
            code: string;
            name: string;
            workshopId: string | null;
            isActive: boolean;
            sortOrder: number;
            metadataJson: string | null;
            createdAt: number;
            updatedAt: number;
          }>;
        }
      | { ok: false; error: string }
    >;
    registerUsage: () => Promise<
      | { ok: true; usage: Record<string, number> }
      | { ok: false; error: string }
    >;
    upsert: (args: {
      id?: string;
      type: 'workshop' | 'regular';
      code: string;
      name: string;
      workshopId?: string | null;
      isActive?: boolean;
      sortOrder?: number;
      metadataJson?: string | null;
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    delete: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  };

  parts: {
    list: (args?: { q?: string; limit?: number; offset?: number; engineBrandId?: string; templateId?: string }) => Promise<
      | {
          ok: true;
          parts: Array<{
            id: string;
            name?: string;
            article?: string;
            templateId?: string;
            templateName?: string;
            dimensions?: PartDimension[];
            brandLinks?: PartEngineBrandLink[];
            contractId?: string;
            statusFlags?: Partial<Record<StatusCode, boolean>>;
            attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
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
            brandLinks?: PartEngineBrandLink[];
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
    partBrandLinks: {
      list: (args: { partId?: string; engineBrandId?: string }) => Promise<
        | {
            ok: true;
            brandLinks: PartEngineBrandLink[];
          }
        | { ok: false; error: string }
      >;
      upsert: (args: {
        partId: string;
        linkId?: string;
        engineBrandId: string;
        assemblyUnitNumber: string;
        quantity: number;
      }) => Promise<
        | {
            ok: true;
            linkId: string;
          }
        | { ok: false; error: string }
      >;
      delete: (args: { partId: string; linkId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
    };
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
  erp: {
    dictionaryList: (moduleName: 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees') => Promise<ErpDictionaryListResult>;
    dictionaryUpsert: (args: {
      moduleName: 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees';
      id?: string;
      code: string;
      name: string;
      payloadJson?: string | null;
    }) => Promise<ErpUpsertResult>;
    cardsList: (moduleName: 'parts' | 'tools' | 'employees') => Promise<ErpCardListResult>;
    cardsUpsert: (args: {
      moduleName: 'parts' | 'tools' | 'employees';
      id?: string;
      templateId?: string | null;
      serialNo?: string | null;
      cardNo?: string | null;
      status?: string | null;
      payloadJson?: string | null;
      fullName?: string | null;
      personnelNo?: string | null;
      roleCode?: string | null;
    }) => Promise<ErpUpsertResult>;
    documentsList: (args?: { status?: string; docType?: string }) => Promise<ErpDocumentListResult>;
    documentsCreate: (args: {
      docType: string;
      docNo: string;
      docDate?: number;
      departmentId?: string | null;
      authorId?: string | null;
      payloadJson?: string | null;
      lines: Array<{ partCardId?: string | null; qty: number; price?: number | null; payloadJson?: string | null }>;
    }) => Promise<ErpUpsertResult>;
    documentsPost: (documentId: string) => Promise<ErpUpsertResult>;
  };
  warehouse: {
    lookupsGet: () => Promise<{ ok: true; lookups: WarehouseLookups } | { ok: false; error: string }>;
    analyticsEngineOutput: (args?: {
      metric?: EngineOutputMetric;
      bucket?: AnalyticsBucket;
      from?: string;
      to?: string;
      workshopId?: string;
    }) => Promise<{ ok: true; result: EngineOutputResult } | { ok: false; error: string }>;
    nomenclatureItemTypesList: () => Promise<{ ok: true; rows: Array<Record<string, unknown>> } | { ok: false; error: string }>;
    nomenclatureItemTypeUpsert: (args: Record<string, unknown>) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    nomenclatureItemTypeDelete: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    nomenclaturePropertiesList: () => Promise<{ ok: true; rows: Array<Record<string, unknown>> } | { ok: false; error: string }>;
    nomenclaturePropertyUpsert: (args: Record<string, unknown>) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    nomenclaturePropertyDelete: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    nomenclatureTemplatesList: () => Promise<{ ok: true; rows: Array<Record<string, unknown>> } | { ok: false; error: string }>;
    nomenclatureTemplateUpsert: (args: Record<string, unknown>) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    nomenclatureTemplateDelete: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    nomenclatureGroupCounts: (args?: {
      search?: string;
      itemType?: string;
      directoryKind?: string;
    }) => Promise<
      | { ok: true; rows: Array<{ groupId: string | null; groupName: string; count: number }> }
      | { ok: false; error: string }
    >;
    stockBalancesByWorkshop: (args: {
      workshopId: string;
      nomenclatureIds: string[];
    }) => Promise<
      | {
          ok: true;
          workshopId: string;
          warehouseId: string;
          balances: Record<string, { onHand: number }>;
        }
      | { ok: false; error: string }
    >;
    nomenclatureList: (args?: {
      id?: string;
      search?: string;
      itemType?: NomenclatureItemType;
      directoryKind?: string;
      directoryRefId?: string;
      groupId?: string;
      isActive?: boolean;
      limit?: number;
      offset?: number;
    }) => Promise<
      | { ok: true; rows: WarehouseNomenclatureListItem[]; hasMore?: boolean }
      | { ok: false; error: string }
    >;
    nomenclatureUpsert: (args: {
      id?: string;
      code: string;
      name: string;
      itemType?: NomenclatureItemType;
      groupId?: string | null;
      unitId?: string | null;
      barcode?: string | null;
      minStock?: number | null;
      maxStock?: number | null;
      sku?: string | null;
      category?: string | null;
      directoryKind?: string | null;
      directoryRefId?: string | null;
      defaultBrandId?: string | null;
      isSerialTracked?: boolean;
      defaultWarehouseId?: string | null;
      specJson?: string | null;
      /** Block D of v1.22.0: native column for BOM component type id (migration 0053). */
      componentTypeId?: string | null;
      isActive?: boolean;
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    nomenclatureDelete: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    stockList: (args?: {
      warehouseId?: string;
      nomenclatureId?: string;
      search?: string;
      lowStockOnly?: boolean;
      limit?: number;
      offset?: number;
    }) => Promise<{ ok: true; rows: WarehouseStockListItem[]; hasMore?: boolean } | { ok: false; error: string }>;
    documentsList: (args?: {
      status?: string;
      docType?: WarehouseDocumentType;
      /** Не возвращать отменённые документы (если в фильтре не выбран явно статус «Отменён»). */
      excludeCancelled?: boolean;
      /** Показывать только документы с этими статусами (имеет приоритет над status/excludeCancelled). */
      statusIn?: string[];
      fromDate?: number;
      toDate?: number;
      search?: string;
      warehouseId?: string;
      limit?: number;
      offset?: number;
    }) => Promise<{ ok: true; rows: WarehouseDocumentListItem[]; hasMore?: boolean } | { ok: false; error: string }>;
    documentGet: (id: string) => Promise<{ ok: true; document: WarehouseDocumentDetails } | { ok: false; error: string }>;
    documentCreate: (args: WarehouseDocumentUpsertInput) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    documentPlan: (id: string) => Promise<{ ok: true; id: string; planned?: boolean } | { ok: false; error: string }>;
    documentPost: (arg: string | { id: string; expectedUpdatedAt?: number }) => Promise<{ ok: true; id: string; posted?: boolean; queued?: boolean } | { ok: false; error: string }>;
    repairFundIntake: (args: { engineId: string; items: Array<{ partId: string; partLabel: string; qty: number }> }) => Promise<
      | { ok: true; posted: number; addedQty: number; nomenclatureCount: number; unchanged: boolean; documentId: string | null; skippedNoNom?: number }
      | { ok: false; error: string }
    >;
    repairFundIntakePreview: (args: { engineId: string; items: Array<{ partId: string; partLabel: string; qty: number }> }) => Promise<
      | { ok: true; pendingQty: number; pendingPositions: number; skippedNoNom: number }
      | { ok: false; error: string }
    >;
    repairFundCaptureInstances: (args: {
      engineId: string;
      instances: Array<{ partId: string; partLabel: string; stampedNumber: string; classification: string }>;
    }) => Promise<
      | {
          ok: true;
          added: number;
          updated: number;
          unchanged: number;
          total: number;
          instances: Array<RepairFundInstancePayload & { operationId: string }>;
          skippedNoNom?: number;
        }
      | { ok: false; error: string }
    >;
    repairFundSetInstanceRepaired: (args: { operationId: string; repaired: boolean }) => Promise<
      | { ok: true; changed: boolean; instances: Array<RepairFundInstancePayload & { operationId: string }> }
      | { ok: false; error: string }
    >;
    documentCancel: (
      arg: string | { id: string; expectedUpdatedAt?: number },
    ) => Promise<{ ok: true; id: string; status: string; queued?: boolean } | { ok: false; error: string }>;
    assemblyBomList: (args?: {
      engineBrandId?: string;
      engineBrandIds?: string[];
      engineNomenclatureId?: string;
      status?: string;
    }) => Promise<{ ok: true; rows: EngineAssemblyBomListItem[] } | { ok: false; error: string }>;
    assemblyBomSchemaGet: () => Promise<{ ok: true; schema: WarehouseBomRelationSchema; updatedAt: number } | { ok: false; error: string }>;
    assemblyBomSchemaSet: (args: {
      schema: WarehouseBomRelationSchema;
      renames?: Array<{ fromTypeId: string; toTypeId: string }>;
    }) => Promise<{ ok: true; schema: WarehouseBomRelationSchema; updatedAt: number; renamedLineCount?: number } | { ok: false; error: string }>;
    assemblyBomSchemaUsageGet: () => Promise<{ ok: true; rows: WarehouseBomRelationTypeUsage[] } | { ok: false; error: string }>;
    assemblyBomGet: (id: string) => Promise<{ ok: true; bom: EngineAssemblyBomDetails } | { ok: false; error: string }>;
    assemblyBomUpsert: (args: EngineAssemblyBomUpsertInput) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    assemblyBomDelete: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    assemblyBomActivateDefault: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    assemblyBomArchive: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    assemblyBomHistory: (args: { engineBrandId: string }) => Promise<{ ok: true; rows: EngineAssemblyBomListItem[] } | { ok: false; error: string }>;
    assemblyBomPrint: (id: string) => Promise<{ ok: true; payload: EngineAssemblyBomDetails } | { ok: false; error: string }>;
    forecastBomGet: (args: {
      engineBrandId: string;
      targetEnginesPerDay?: number;
      horizonDays?: number;
      warehouseIds?: string[];
    }) => Promise<{ ok: true; rows: EngineAssemblyBomExpandedRow[]; warnings?: string[] } | { ok: false; error: string }>;
    forecastIncomingGet: (args: WarehouseForecastIncomingFilter) => Promise<{ ok: true; rows: WarehouseForecastIncomingRow[] } | { ok: false; error: string }>;
    movementsList: (args?: {
      nomenclatureId?: string;
      warehouseId?: string;
      documentHeaderId?: string;
      fromDate?: number;
      toDate?: number;
      limit?: number;
    }) => Promise<{ ok: true; rows: WarehouseMovementListItem[] } | { ok: false; error: string }>;
    nomenclaturePartSpecsList: (args?: { templateId?: string; engineBrandId?: string }) => Promise<
      | { ok: true; rows: Array<{ id: string; name: string; isActive: boolean; templateName: string | null; metadata: PartMetadata } & PartSpec> }
      | { ok: false; error: string }
    >;
    nomenclaturePartSpecGet: (args: { nomenclatureId: string }) => Promise<
      | { ok: true; spec: PartSpec | null; metadata: PartMetadata | null; name: string | null; isActive: boolean | null }
      | { ok: false; error: string }
    >;
    nomenclatureDirectoryPartCreate: (args: { name: string; code?: string | null }) => Promise<
      { ok: true; part: { id: string } } | { ok: false; error: string }
    >;
    nomenclaturePartSpecUpdate: (args: { nomenclatureId: string; spec: PartSpec; metadata?: PartMetadata }) => Promise<
      { ok: true; spec: PartSpec; metadata: PartMetadata | null } | { ok: false; error: string }
    >;
    engineInstancesList: (args?: {
      nomenclatureId?: string;
      contractId?: string;
      warehouseId?: string;
      status?: EngineInstanceStatus | string;
      search?: string;
      limit?: number;
      offset?: number;
    }) => Promise<{ ok: true; rows: EngineInstanceListItem[]; hasMore?: boolean } | { ok: false; error: string }>;
    engineInstanceUpsert: (args: {
      id?: string;
      nomenclatureId: string;
      serialNumber: string;
      contractId?: string | null;
      contractSectionNumber?: string | null;
      warehouseId?: string;
      currentStatus?: EngineInstanceStatus | string;
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    engineInstanceDelete: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
    contractSectionsGet: (contractId: string) => Promise<{ ok: true; sections: string[] } | { ok: false; error: string }>;
  };

  files: {
    // Загружает файл на сервер (сервер сам решает: локально или Яндекс.Диск).
    upload: (args: { path: string; fileName?: string; scope?: { ownerType: string; ownerId: string; category: string } }) => Promise<
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
    // Возвращает data: URL оригинала (полноразмерное изображение) для крупного просмотра в галерее.
    originalGet: (args: { fileId: string }) => Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>;
    // Копирует изображение в буфер обмена Windows (одно изображение).
    copyImage: (args: { fileId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
    // Сохраняет копии выбранных файлов в выбранную пользователем папку (или на флешку).
    copyToFolder: (args: { fileIds: string[] }) => Promise<{ ok: true; count: number } | { ok: false; error: string }>;
    // Собирает оригиналы во временную папку и открывает её в Проводнике (для перетаскивания в Telegram/MAX); mailto — заодно открыть черновик письма.
    revealForShare: (args: { fileIds: string[]; label?: string; mailto?: boolean }) => Promise<{ ok: true; folder: string } | { ok: false; error: string }>;
    // Собирает выбранные фото в один PDF и сохраняет по выбранному пути (по умолчанию — Рабочий стол).
    assemblePdf: (args: { fileIds: string[]; defaultName?: string }) => Promise<{ ok: true; savePath: string } | { ok: false; error: string }>;
    // Печатает выбранные фото (1 фото на A4) на принтер.
    print: (args: { fileIds: string[] }) => Promise<{ ok: true } | { ok: false; error: string }>;
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
    sendTextEverywhere: (args: { recipientUserId?: string | null; text: string }) => Promise<ChatSendResult>;
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
    conversationsList: (args: { limit?: number }) => Promise<AiAgentConversationsListResponse>;
    conversationMessages: (args: { conversationId: string; limit?: number }) => Promise<AiAgentConversationMessagesResponse>;
    conversationDelete: (args: { conversationId: string }) => Promise<AiAgentConversationDeleteResponse>;
    conversationSearch: (args: { conversationId: string; query: string; limit?: number }) => Promise<AiAgentConversationSearchResponse>;
    assistStream: (
      args: AiAgentAssistRequest,
      onEvent: (ev: AiAgentStreamEvent) => void,
    ) => Promise<AiAgentAssistResponse>;
  };
};


