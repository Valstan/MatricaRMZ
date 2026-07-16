import { contextBridge, ipcRenderer } from 'electron';
import type { ChatDeepLinkPayload, PartMetadata } from '@matricarmz/shared';

// API, доступный в renderer. Дальше будем расширять CRUD и синхронизацию.
const matricaApi = {
  ping: async () => ipcRenderer.invoke('app:ping'),
  app: {
    version: async () => ipcRenderer.invoke('app:version'),
    navigateDeepLink: async (link: ChatDeepLinkPayload) => ipcRenderer.invoke('app:navigateDeepLink', link),
    onDeepLink: (handler: (link: ChatDeepLinkPayload) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, link: ChatDeepLinkPayload) => handler(link);
      ipcRenderer.on('app:deep-link-event', wrapped);
      return () => ipcRenderer.removeListener('app:deep-link-event', wrapped);
    },
    onCloseRequest: (handler: () => void) => {
      const wrapped = () => handler();
      ipcRenderer.on('app:close-request', wrapped);
      return () => ipcRenderer.removeListener('app:close-request', wrapped);
    },
    respondToCloseRequest: (args: { allowClose: boolean }) => {
      ipcRenderer.send('app:close-response', args);
    },
  },
  search: {
    global: async (args: { q: string; limit?: number }) => ipcRenderer.invoke('search:global', args),
    cardContent: async (args: { entityIds: string[]; q: string }) => ipcRenderer.invoke('search:cardContent', args),
    enginesByStampedNumber: async (args: { q: string; limit?: number }) =>
      ipcRenderer.invoke('search:enginesByStampedNumber', args),
  },
  activity: {
    report: (args: { activeDate: string; activeMs: number }) => ipcRenderer.send('activity:report', args),
  },
  log: {
    send: async (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      ipcRenderer.invoke('log:send', { level, message }),
  },
  auth: {
    status: async () => ipcRenderer.invoke('auth:status'),
    sync: async () => ipcRenderer.invoke('auth:sync'),
    login: async (args: { username: string; password: string }) => ipcRenderer.invoke('auth:login', args),
    loginSuggest: async (args: { q: string }) => ipcRenderer.invoke('auth:loginSuggest', args),
    loginMru: async () => ipcRenderer.invoke('auth:loginMru'),
    register: async (args: { login: string; password: string; fullName: string; position: string }) =>
      ipcRenderer.invoke('auth:register', args),
    logout: async (args: { refreshToken?: string }) => ipcRenderer.invoke('auth:logout', args),
    changePassword: async (args: { currentPassword: string; newPassword: string }) => ipcRenderer.invoke('auth:changePassword', args),
    profileGet: async () => ipcRenderer.invoke('auth:profileGet'),
    profileUpdate: async (args: {
      fullName?: string | null;
      position?: string | null;
      sectionName?: string | null;
      chatDisplayName?: string | null;
      telegramLogin?: string | null;
      maxLogin?: string | null;
    }) =>
      ipcRenderer.invoke('auth:profileUpdate', args),
    uiProfileGet: async () => ipcRenderer.invoke('auth:uiProfileGet'),
    uiProfileSet: async (args: { profile: unknown }) => ipcRenderer.invoke('auth:uiProfileSet', args),
  },
  presence: {
    me: async () => ipcRenderer.invoke('presence:me'),
  },
  engines: {
    list: async () => ipcRenderer.invoke('engine:list'),
    create: async () => ipcRenderer.invoke('engine:create'),
    get: async (id: string) => ipcRenderer.invoke('engine:get', id),
    setAttr: async (engineId: string, code: string, value: unknown) =>
      ipcRenderer.invoke('engine:setAttr', engineId, code, value),
    advanceStatus: async (args: { engineId: string; target: 'status_repair_started' | 'status_repaired'; dateMs: number }) =>
      ipcRenderer.invoke('engine:advanceStatus', args),
    delete: async (engineId: string) => ipcRenderer.invoke('engine:delete', engineId),
    findDuplicateCandidates: async (args: { engineNumber: string; excludeEngineId?: string }) =>
      ipcRenderer.invoke('engine:findDuplicateCandidates', args),
    findInternalNumberDuplicate: async (args: {
      internalNumber: string;
      internalNumberYear: number;
      excludeEngineId?: string;
    }) => ipcRenderer.invoke('engine:findInternalNumberDuplicate', args),
    dedupeAnalyze: async () => ipcRenderer.invoke('engine:dedupe:analyze'),
    dedupeMerge: async (args: { survivorId: string; loserIds: string[] }) => ipcRenderer.invoke('engine:dedupe:merge', args),
  },
  maintenance: {
    emptyCardsAnalyze: async () => ipcRenderer.invoke('maintenance:emptyCards:analyze'),
    emptyCardsDelete: async (args: { ids: string[] }) => ipcRenderer.invoke('maintenance:emptyCards:delete', args),
  },
  drafts: {
    save: async (args: { cardType: string; cardId: string; kind?: 'recovery' | 'explicit'; title?: string | null; payloadJson?: string | null; baseUpdatedAt?: number | null }) =>
      ipcRenderer.invoke('drafts:save', args),
    list: async () => ipcRenderer.invoke('drafts:list'),
    get: async (args: { cardType: string; cardId: string }) => ipcRenderer.invoke('drafts:get', args),
    clear: async (args: { id?: string; cardType?: string; cardId?: string }) => ipcRenderer.invoke('drafts:clear', args),
  },
  operations: {
    list: async (engineId: string) => ipcRenderer.invoke('ops:list', engineId),
    add: async (engineId: string, operationType: string, status: string, note?: string, metaJson?: string | null) =>
      ipcRenderer.invoke('ops:add', engineId, operationType, status, note, metaJson),
  },
  audit: {
    list: async () => ipcRenderer.invoke('audit:list'),
    add: async (args: { action: string; entityId?: string | null; tableName?: string | null; payload?: unknown }) =>
      ipcRenderer.invoke('audit:add', args),
  },
  sync: {
    run: async () => ipcRenderer.invoke('sync:run'),
    status: async () => ipcRenderer.invoke('sync:status'),
    configGet: async () => ipcRenderer.invoke('sync:config:get'),
    configSet: async (args: { apiBaseUrl: string }) => ipcRenderer.invoke('sync:config:set', args),
    reset: async () => ipcRenderer.invoke('sync:reset'),
    fullPull: async () => ipcRenderer.invoke('sync:fullPull'),
    resetLocalDb: async () => ipcRenderer.invoke('sync:resetLocalDb'),
    onProgress: (handler: (event: any) => void) => {
      const wrapped = (_e: Electron.IpcRendererEvent, payload: any) => handler(payload);
      ipcRenderer.on('sync:progress', wrapped);
      return () => ipcRenderer.removeListener('sync:progress', wrapped);
    },
  },
  changes: {
    list: async (args?: { status?: string; limit?: number }) => ipcRenderer.invoke('changes:list', args),
    apply: async (args: { id: string }) => ipcRenderer.invoke('changes:apply', args),
    reject: async (args: { id: string }) => ipcRenderer.invoke('changes:reject', args),
  },
  server: {
    health: async () => ipcRenderer.invoke('server:health'),
  },
  diagnostics: {
    criticalEventsList: async (args?: { days?: number; limit?: number }) => ipcRenderer.invoke('diagnostics:criticalEvents:list', args),
    criticalEventsDelete: async (args: { id: string }) => ipcRenderer.invoke('diagnostics:criticalEvents:delete', args),
    criticalEventsClear: async () => ipcRenderer.invoke('diagnostics:criticalEvents:clear'),
  },
  reports: {
    presetList: async () => ipcRenderer.invoke('reports:presetList'),
    presetPreview: async (args: { presetId: string; filters?: Record<string, unknown> }) => ipcRenderer.invoke('reports:presetPreview', args),
    presetPdf: async (args: { presetId: string; filters?: Record<string, unknown> }) => ipcRenderer.invoke('reports:presetPdf', args),
    presetCsv: async (args: { presetId: string; filters?: Record<string, unknown> }) => ipcRenderer.invoke('reports:presetCsv', args),
    preset1cXml: async (args: { presetId: string; filters?: Record<string, unknown> }) => ipcRenderer.invoke('reports:preset1cXml', args),
    presetPrint: async (args: { presetId: string; filters?: Record<string, unknown> }) => ipcRenderer.invoke('reports:presetPrint', args),
    favoritesGet: async (args?: { userId?: string }) => ipcRenderer.invoke('reports:favoritesGet', args),
    favoritesSet: async (args: { userId?: string; ids: string[] }) => ipcRenderer.invoke('reports:favoritesSet', args),
    historyList: async (args?: { userId?: string; limit?: number }) => ipcRenderer.invoke('reports:historyList', args),
    historyAdd: async (args: { userId?: string; entry: { presetId: string; title: string; generatedAt: number } }) =>
      ipcRenderer.invoke('reports:historyAdd', args),
    filterTemplatesList: async (args: { userId?: string; presetId: string }) =>
      ipcRenderer.invoke('reports:filterTemplatesList', args),
    filterTemplateSave: async (args: {
      userId?: string;
      presetId: string;
      template: { id?: string; name: string; filters: Record<string, unknown>; disabled: string[] };
    }) => ipcRenderer.invoke('reports:filterTemplateSave', args),
    filterTemplateDelete: async (args: { userId?: string; presetId: string; templateId: string }) =>
      ipcRenderer.invoke('reports:filterTemplateDelete', args),
    customSources: async () => ipcRenderer.invoke('reports:customSources'),
    customRun: async (args: { spec: unknown }) => ipcRenderer.invoke('reports:customRun', args),
    customPrint: async (args: { spec: unknown }) => ipcRenderer.invoke('reports:customPrint', args),
    customCsv: async (args: { spec: unknown }) => ipcRenderer.invoke('reports:customCsv', args),
    customTemplatesList: async (args?: { userId?: string }) => ipcRenderer.invoke('reports:customTemplatesList', args),
    customTemplateSave: async (args: { userId?: string; template: { id?: string; name: string; spec: unknown } }) =>
      ipcRenderer.invoke('reports:customTemplateSave', args),
    customTemplateDelete: async (args: { userId?: string; templateId: string }) =>
      ipcRenderer.invoke('reports:customTemplateDelete', args),
    periodStagesCsv: async (args: { startMs?: number; endMs: number }) => ipcRenderer.invoke('reports:periodStagesCsv', args),
    periodStagesByLinkCsv: async (args: { startMs?: number; endMs: number; linkAttrCode: string }) =>
      ipcRenderer.invoke('reports:periodStagesByLinkCsv', args),
    defectSupplyPreview: async (args: {
      startMs?: number;
      endMs: number;
      contractIds?: string[];
      brandIds?: string[];
      includePurchases?: boolean;
    }) => ipcRenderer.invoke('reports:defectSupplyPreview', args),
    defectSupplyPdf: async (args: {
      startMs?: number;
      endMs: number;
      contractIds?: string[];
      contractLabels: string[];
      brandIds?: string[];
      includePurchases?: boolean;
    }) =>
      ipcRenderer.invoke('reports:defectSupplyPdf', args),
    defectSupplyPrint: async (args: {
      startMs?: number;
      endMs: number;
      contractIds?: string[];
      contractLabels: string[];
      brandIds?: string[];
      includePurchases?: boolean;
    }) =>
      ipcRenderer.invoke('reports:defectSupplyPrint', args),
  },
  reportsBuilder: {
    meta: async () => ipcRenderer.invoke('reportsBuilder:meta'),
    preview: async (args: any) => ipcRenderer.invoke('reportsBuilder:preview', args),
    export: async (args: any) => ipcRenderer.invoke('reportsBuilder:export', args),
    exportPdf: async (args: any) => ipcRenderer.invoke('reportsBuilder:exportPdf', args),
    print: async (args: any) => ipcRenderer.invoke('reportsBuilder:print', args),
  },
  admin: {
    entityTypes: {
      list: async () => ipcRenderer.invoke('admin:entityTypes:list'),
      upsert: async (args: { id?: string; code: string; name: string }) => ipcRenderer.invoke('admin:entityTypes:upsert', args),
      deleteInfo: async (entityTypeId: string) => ipcRenderer.invoke('admin:entityTypes:deleteInfo', entityTypeId),
      delete: async (args: { entityTypeId: string; deleteEntities: boolean; deleteDefs: boolean }) =>
        ipcRenderer.invoke('admin:entityTypes:delete', args),
      resyncFromServer: async (entityTypeId: string) => ipcRenderer.invoke('admin:entityTypes:resyncFromServer', entityTypeId),
      resyncAllFromServer: async () => ipcRenderer.invoke('admin:entityTypes:resyncAllFromServer'),
    },
    attributeDefs: {
      listByEntityType: async (entityTypeId: string) => ipcRenderer.invoke('admin:attributeDefs:listByEntityType', entityTypeId),
      upsert: async (args: {
        id?: string;
        entityTypeId: string;
        code: string;
        name: string;
        dataType: string;
        isRequired?: boolean;
        sortOrder?: number;
        metaJson?: string | null;
      }) => ipcRenderer.invoke('admin:attributeDefs:upsert', args),
      deleteInfo: async (attributeDefId: string) => ipcRenderer.invoke('admin:attributeDefs:deleteInfo', attributeDefId),
      delete: async (args: { attributeDefId: string; deleteValues: boolean }) => ipcRenderer.invoke('admin:attributeDefs:delete', args),
    },
    entities: {
      listByEntityType: async (entityTypeId: string) => ipcRenderer.invoke('admin:entities:listByEntityType', entityTypeId),
      create: async (entityTypeId: string) => ipcRenderer.invoke('admin:entities:create', entityTypeId),
      get: async (id: string, fallbackTypeId?: string) => ipcRenderer.invoke('admin:entities:get', id, fallbackTypeId),
      setAttr: async (entityId: string, code: string, value: unknown, fallbackTypeId?: string) =>
        ipcRenderer.invoke('admin:entities:setAttr', entityId, code, value, fallbackTypeId),
      findDuplicates: async (args: { entityTypeId: string; query: { name?: string; article?: string; price?: number }; excludeEntityId?: string }) =>
        ipcRenderer.invoke('admin:entities:findDuplicates', args),
      deleteInfo: async (entityId: string) => ipcRenderer.invoke('admin:entities:deleteInfo', entityId),
      detachLinksAndDelete: async (entityId: string) => ipcRenderer.invoke('admin:entities:detachLinksAndDelete', entityId),
      softDelete: async (entityId: string) => ipcRenderer.invoke('admin:entities:softDelete', entityId),
    },
    users: {
      list: async () => ipcRenderer.invoke('admin:users:list'),
      create: async (args: { login: string; password: string; role: string; fullName?: string; accessEnabled?: boolean }) =>
        ipcRenderer.invoke('admin:users:create', args),
      update: async (userId: string, args: { role?: string; accessEnabled?: boolean; password?: string; login?: string; fullName?: string }) =>
        ipcRenderer.invoke('admin:users:update', userId, args),
      deleteRequest: async (userId: string) => ipcRenderer.invoke('admin:users:deleteRequest', userId),
      deleteConfirm: async (userId: string) => ipcRenderer.invoke('admin:users:deleteConfirm', userId),
      deleteCancel: async (userId: string) => ipcRenderer.invoke('admin:users:deleteCancel', userId),
      changeRequestsList: async () => ipcRenderer.invoke('admin:users:changeRequestsList'),
      changeRequestsDecide: async (args: { id: string; action: 'approve' | 'reject'; note?: string }) =>
        ipcRenderer.invoke('admin:users:changeRequestsDecide', args),
      pendingApprove: async (args: { pendingUserId: string; action: 'approve' | 'merge'; role?: 'user' | 'admin'; targetUserId?: string }) =>
        ipcRenderer.invoke('admin:users:pendingApprove', args),
      permissionsGet: async (userId: string) => ipcRenderer.invoke('admin:users:permissionsGet', userId),
      permissionsSet: async (userId: string, set: Record<string, boolean>) => ipcRenderer.invoke('admin:users:permissionsSet', userId, set),
      delegationsList: async (userId: string) => ipcRenderer.invoke('admin:users:delegationsList', userId),
      delegationCreate: async (args: {
        fromUserId: string;
        toUserId: string;
        permCode: string;
        startsAt?: number;
        endsAt: number;
        note?: string;
      }) => ipcRenderer.invoke('admin:users:delegationCreate', args),
      delegationRevoke: async (args: { id: string; note?: string }) => ipcRenderer.invoke('admin:users:delegationRevoke', args),
    },
    audit: {
      list: async (args?: { limit?: number; fromMs?: number; toMs?: number; actor?: string; actionType?: string }) =>
        ipcRenderer.invoke('admin:audit:list', args),
      dailySummary: async (args?: { date?: string; cutoffHour?: number }) => ipcRenderer.invoke('admin:audit:dailySummary', args),
    },
  },
  access: {
    sectionsSelf: async () => ipcRenderer.invoke('access:sections:self'),
  },
  employees: {
    list: async () => ipcRenderer.invoke('employees:list'),
    get: async (id: string) => ipcRenderer.invoke('employees:get', id),
    create: async () => ipcRenderer.invoke('employees:create'),
    setAttr: async (employeeId: string, code: string, value: unknown) =>
      ipcRenderer.invoke('employees:setAttr', employeeId, code, value),
    delete: async (employeeId: string) => ipcRenderer.invoke('employees:delete', employeeId),
    merge: async () => ipcRenderer.invoke('employees:merge'),
    resyncFromServer: async () => ipcRenderer.invoke('employees:resyncFromServer'),
    departmentsList: async () => ipcRenderer.invoke('employees:departments:list'),
    defs: async () => ipcRenderer.invoke('employees:defs'),
    permissionsGet: async (userId: string) => ipcRenderer.invoke('employees:permissionsGet', userId),
  },
  timesheets: {
    codes: async () => ipcRenderer.invoke('timesheets:codes'),
    departments: async () => ipcRenderer.invoke('timesheets:departments'),
    list: async (args?: { workshopId?: string; departmentId?: string; year?: number }) => ipcRenderer.invoke('timesheets:list', args),
    get: async (id: string) => ipcRenderer.invoke('timesheets:get', id),
    create: async (args: { workshopId?: string; departmentId?: string; year: number; month: number; weekMode?: 5 | 6; shiftHours?: number }) =>
      ipcRenderer.invoke('timesheets:create', args),
    update: async (args: { id: string; status?: 'draft' | 'closed'; weekMode?: 5 | 6; normHours?: number | null; allowOthersEdit?: boolean }) =>
      ipcRenderer.invoke('timesheets:update', args),
    delete: async (id: string) => ipcRenderer.invoke('timesheets:delete', id),
    addRows: async (args: { timesheetId: string; employees: Array<{ employeeId: string; tabNumber?: string | null; position?: string | null }> }) =>
      ipcRenderer.invoke('timesheets:addRows', args),
    removeRow: async (rowId: string) => ipcRenderer.invoke('timesheets:removeRow', rowId),
    reorderRows: async (args: { timesheetId: string; rowIds: string[] }) => ipcRenderer.invoke('timesheets:reorderRows', args),
    setCells: async (args: { rowId: string; cells: Array<{ day: number; code?: string | null; hours?: number | null; comment?: string | null }> }) =>
      ipcRenderer.invoke('timesheets:setCells', args),
  },
  update: {
    check: async () => ipcRenderer.invoke('update:check'),
    status: async () => ipcRenderer.invoke('update:status'),
    reset: async () => ipcRenderer.invoke('update:reset'),
    downloadDirGet: async () => ipcRenderer.invoke('update:downloadDir:get'),
    downloadDirPick: async () => ipcRenderer.invoke('update:downloadDir:pick'),
  },
  checklists: {
    templatesList: async (args?: { stage?: string }) => ipcRenderer.invoke('checklists:templates:list', args),
    engineGet: async (args: { engineId: string; stage: string }) => ipcRenderer.invoke('checklists:engine:get', args),
    engineSave: async (args: { engineId: string; stage: string; templateId: string; operationId?: string | null; answers: unknown }) =>
      ipcRenderer.invoke('checklists:engine:save', args),
    engineActSnapshot: async (args: {
      engineId: string;
      actType: 'completeness' | 'defect' | 'claim';
      rows: unknown[];
      header: { engineBrand: string; engineNumber: string; contractNumber: string; engineInternalNumber?: string };
      answers: unknown;
      selectedCount: number;
    }) => ipcRenderer.invoke('checklists:engine:actSnapshot', args),
    engineActVersions: async (args: { engineId: string; actType: 'completeness' | 'defect' | 'claim' }) =>
      ipcRenderer.invoke('checklists:engine:actVersions', args),
    enginePartStatusEvents: async (args: { engineId: string }) =>
      ipcRenderer.invoke('checklists:engine:partStatusEvents', args),
    engineStampedInstances: async (args: { engineId: string }) =>
      ipcRenderer.invoke('checklists:engine:stampedInstances', args),
    requirementVersions: async (args: { engineId: string }) =>
      ipcRenderer.invoke('checklists:engine:requirementVersions', args),
    requirementSnapshot: async (args: {
      engineId: string;
      instances: unknown[];
      header: { engineBrand: string; engineNumber: string; contractNumber: string; engineInternalNumber?: string };
    }) => ipcRenderer.invoke('checklists:engine:requirementSnapshot', args),
  },
  supplyRequests: {
    list: async (args?: { q?: string; month?: string }) => ipcRenderer.invoke('supplyRequests:list', args),
    get: async (id: string) => ipcRenderer.invoke('supplyRequests:get', id),
    create: async () => ipcRenderer.invoke('supplyRequests:create'),
    update: async (args: { id: string; payload: unknown }) => ipcRenderer.invoke('supplyRequests:update', args),
    delete: async (id: string) => ipcRenderer.invoke('supplyRequests:delete', id),
    transition: async (args: { id: string; action: string; note?: string | null }) => ipcRenderer.invoke('supplyRequests:transition', args),
  },
  uiScreens: {
    list: async () => ipcRenderer.invoke('uiScreens:list'),
    get: async (id: string) => ipcRenderer.invoke('uiScreens:get', id),
    save: async (args: { id?: string; name: string; sectionId: string; specJson: string }) =>
      ipcRenderer.invoke('uiScreens:save', args),
    delete: async (id: string) => ipcRenderer.invoke('uiScreens:delete', id),
  },
  workOrders: {
    list: async (args?: { q?: string; month?: string }) => ipcRenderer.invoke('workOrders:list', args),
    get: async (id: string) => ipcRenderer.invoke('workOrders:get', id),
    activeAssemblyVariant: async (engineId: string) => ipcRenderer.invoke('workOrders:activeAssemblyVariant', engineId),
    create: async () => ipcRenderer.invoke('workOrders:create'),
    update: async (args: { id: string; payload: unknown }) => ipcRenderer.invoke('workOrders:update', args),
    delete: async (id: string) => ipcRenderer.invoke('workOrders:delete', id),
    close: async (args: { operationId: string; expectedUpdatedAt?: number }) => ipcRenderer.invoke('workOrders:close', args),
    saveAssemblyDraft: async (args: { operationId: string; expectedUpdatedAt?: number }) =>
      ipcRenderer.invoke('workOrders:saveAssemblyDraft', args),
    postAssembly: async (args: { operationId: string; expectedUpdatedAt?: number }) =>
      ipcRenderer.invoke('workOrders:postAssembly', args),
    deleteAssemblyDraft: async (args: { operationId: string; expectedUpdatedAt?: number }) =>
      ipcRenderer.invoke('workOrders:deleteAssemblyDraft', args),
    createAssemblyFromForecast: async (args: {
      variantKey: string;
      brandId: string;
      engineBrandName?: string;
      requiredParts: Array<{ partId: string; qty: number; partLabel: string; sourceWarehouseId?: string }>;
      engineId?: string;
      engineNumber?: string;
    }) => ipcRenderer.invoke('workOrders:createAssemblyFromForecast', args),
    assemblyReturn: async (args: {
      engineId: string;
      reason?: string | null;
      docDate?: number;
      lines: Array<{ nomenclatureId: string; qty: number; mode: 'rework' | 'scrap' }>;
    }) => ipcRenderer.invoke('workOrders:assemblyReturn', args),
    assemblyInProgress: async (engineId: string) => ipcRenderer.invoke('workOrders:assemblyInProgress', engineId),
    createRepairFromDefects: async (args: {
      engineId: string;
      engineNumber?: string;
      engineBrandId?: string;
      engineBrandName?: string;
      items: Array<{ partId: string; qty: number; partLabel: string }>;
    }) => ipcRenderer.invoke('workOrders:createRepairFromDefects', args),
    engineRepairPartStates: async (engineId: string) => ipcRenderer.invoke('workOrders:engineRepairPartStates', engineId),
  },
  workOrderTemplates: {
    list: async (args?: { kind?: string }) => ipcRenderer.invoke('workOrderTemplates:list', args),
    get: async (id: string) => ipcRenderer.invoke('workOrderTemplates:get', id),
    create: async (args: {
      workOrderKind: string;
      name: string;
      payloadOverrides?: Record<string, unknown>;
      hiddenFields?: string[];
      lines?: Array<Record<string, unknown>>;
    }) => ipcRenderer.invoke('workOrderTemplates:create', args),
    update: async (args: {
      id: string;
      name?: string;
      payloadOverrides?: Record<string, unknown>;
      hiddenFields?: string[];
      lines?: Array<Record<string, unknown>>;
    }) => ipcRenderer.invoke('workOrderTemplates:update', args),
    delete: async (id: string) => ipcRenderer.invoke('workOrderTemplates:delete', id),
  },
  engineActTemplates: {
    list: async (args?: { engineBrandId?: string }) => ipcRenderer.invoke('engineActTemplates:list', args),
    get: async (id: string) => ipcRenderer.invoke('engineActTemplates:get', id),
    create: async (args: { engineBrandId: string; name: string; payload?: Record<string, unknown> }) =>
      ipcRenderer.invoke('engineActTemplates:create', args),
    update: async (args: { id: string; name?: string; payload?: Record<string, unknown> }) =>
      ipcRenderer.invoke('engineActTemplates:update', args),
    delete: async (id: string) => ipcRenderer.invoke('engineActTemplates:delete', id),
  },
  signatureCaptions: {
    list: async () => ipcRenderer.invoke('signatureCaptions:list'),
    add: async (args: { text: string }) => ipcRenderer.invoke('signatureCaptions:add', args),
  },
  workshops: {
    list: async (args?: { activeOnly?: boolean }) => ipcRenderer.invoke('workshops:list', args),
    stats: async (args?: { from?: string; to?: string; workshopId?: string }) =>
      ipcRenderer.invoke('workshops:stats', args),
    upsert: async (args: { id?: string; code: string; name: string; isActive?: boolean; displayOrder?: number; metadataJson?: string | null }) =>
      ipcRenderer.invoke('workshops:upsert', args),
    delete: async (id: string) => ipcRenderer.invoke('workshops:delete', id),
    getRepairTemplate: async (workshopId: string) =>
      ipcRenderer.invoke('workshops:getRepairTemplate', workshopId),
    setRepairTemplate: async (args: {
      workshopId: string;
      lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
    }) => ipcRenderer.invoke('workshops:setRepairTemplate', args),
    listRepairTemplates: async (workshopId: string) =>
      ipcRenderer.invoke('workshops:listRepairTemplates', workshopId),
    getRepairTemplateById: async (args: { workshopId: string; templateId: string }) =>
      ipcRenderer.invoke('workshops:getRepairTemplateById', args),
    createRepairTemplate: async (args: {
      workshopId: string;
      name: string;
      lines: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
    }) => ipcRenderer.invoke('workshops:createRepairTemplate', args),
    updateRepairTemplate: async (args: {
      workshopId: string;
      templateId: string;
      name?: string;
      lines?: Array<{ nomenclatureId: string; unit: string; defaultQty?: number; serviceId?: string }>;
    }) => ipcRenderer.invoke('workshops:updateRepairTemplate', args),
    deleteRepairTemplate: async (args: { workshopId: string; templateId: string }) =>
      ipcRenderer.invoke('workshops:deleteRepairTemplate', args),
  },
  warehouseLocations: {
    list: async (args?: { type?: 'system' | 'workshop' | 'regular'; activeOnly?: boolean }) =>
      ipcRenderer.invoke('warehouseLocations:list', args),
    registerUsage: async () => ipcRenderer.invoke('warehouseLocations:registerUsage'),
    upsert: async (args: {
      id?: string;
      type: 'workshop' | 'regular';
      code: string;
      name: string;
      workshopId?: string | null;
      isActive?: boolean;
      sortOrder?: number;
      metadataJson?: string | null;
    }) => ipcRenderer.invoke('warehouseLocations:upsert', args),
    delete: async (id: string) => ipcRenderer.invoke('warehouseLocations:delete', id),
  },
  tools: {
    list: async (args?: { q?: string }) => ipcRenderer.invoke('tools:list', args),
    get: async (id: string) => ipcRenderer.invoke('tools:get', id),
    create: async () => ipcRenderer.invoke('tools:create'),
    setAttr: async (args: { toolId: string; code: string; value: unknown }) => ipcRenderer.invoke('tools:setAttr', args),
    delete: async (id: string) => ipcRenderer.invoke('tools:delete', id),
    exportPdf: async (toolId: string) => ipcRenderer.invoke('tools:exportPdf', toolId),
    scope: async () => ipcRenderer.invoke('tools:scope'),
    movements: {
      list: async (toolId: string) => ipcRenderer.invoke('tools:movements:list', toolId),
      listAll: async () => ipcRenderer.invoke('tools:movements:listAll'),
      add: async (args: {
        toolId: string;
        movementAt: number;
        mode: 'received' | 'returned';
        employeeId?: string | null;
        confirmed?: boolean;
        confirmedById?: string | null;
        comment?: string | null;
      }) => ipcRenderer.invoke('tools:movements:add', args),
      update: async (args: {
        id: string;
        toolId: string;
        movementAt: number;
        mode: 'received' | 'returned';
        employeeId?: string | null;
        confirmed?: boolean;
        confirmedById?: string | null;
        comment?: string | null;
      }) => ipcRenderer.invoke('tools:movements:update', args),
      delete: async (args: { id: string; toolId: string }) => ipcRenderer.invoke('tools:movements:delete', args),
    },
    properties: {
      list: async () => ipcRenderer.invoke('tools:properties:list'),
      get: async (id: string) => ipcRenderer.invoke('tools:properties:get', id),
      create: async () => ipcRenderer.invoke('tools:properties:create'),
      setAttr: async (args: { id: string; code: string; value: unknown }) => ipcRenderer.invoke('tools:properties:setAttr', args),
      delete: async (id: string) => ipcRenderer.invoke('tools:properties:delete', id),
      valueHints: async (propertyId: string) => ipcRenderer.invoke('tools:properties:valueHints', propertyId),
    },
    catalog: {
      list: async () => ipcRenderer.invoke('tools:catalog:list'),
      create: async (args: { name: string }) => ipcRenderer.invoke('tools:catalog:create', args),
    },
    employees: {
      list: async (args?: { departmentId?: string | null }) => ipcRenderer.invoke('tools:employees:list', args),
    },
    report: async (args: {
      startMs?: number | null;
      endMs?: number | null;
      nameQuery?: string | null;
      propertyId?: string | null;
      propertyValue?: string | null;
      location?: 'store' | 'in_use' | 'unknown' | null;
    }) => ipcRenderer.invoke('tools:report', args),
  },
  parts: {
    list: async (args?: { q?: string; limit?: number; offset?: number; engineBrandId?: string; templateId?: string }) =>
      ipcRenderer.invoke('parts:list', args),
    get: async (partId: string) => ipcRenderer.invoke('parts:get', partId),
    create: async (args?: { attributes?: Record<string, unknown> }) => ipcRenderer.invoke('parts:create', args),
    createAttributeDef: async (args: {
      code: string;
      name: string;
      dataType: 'text' | 'number' | 'boolean' | 'date' | 'json' | 'link';
      isRequired?: boolean;
      sortOrder?: number;
      metaJson?: string | null;
    }) => ipcRenderer.invoke('parts:attributeDefCreate', args),
    updateAttribute: async (args: { partId: string; attributeCode: string; value: unknown }) =>
      ipcRenderer.invoke('parts:updateAttribute', args),
    partBrandLinks: {
      list: async (args: { partId?: string; engineBrandId?: string }) => ipcRenderer.invoke('parts:partBrandLinks:list', args),
      upsert: async (args: {
        partId: string;
        linkId?: string;
        engineBrandId: string;
        assemblyUnitNumber: string;
        quantity: number;
      }) =>
        ipcRenderer.invoke('parts:partBrandLinks:upsert', {
          partId: args.partId,
          engineBrandId: args.engineBrandId,
          assemblyUnitNumber: args.assemblyUnitNumber,
          quantity: args.quantity,
          ...(args.linkId ? { linkId: args.linkId } : {}),
        }),
      delete: async (args: { partId: string; linkId: string }) => ipcRenderer.invoke('parts:partBrandLinks:delete', args),
    },
    delete: async (partId: string) => ipcRenderer.invoke('parts:delete', partId),
    getFiles: async (partId: string) => ipcRenderer.invoke('parts:getFiles', partId),
  },
  erp: {
    dictionaryList: async (moduleName: 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees') =>
      ipcRenderer.invoke('erp:dictionary:list', moduleName),
    dictionaryUpsert: async (args: {
      moduleName: 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees';
      id?: string;
      code: string;
      name: string;
      payloadJson?: string | null;
    }) => ipcRenderer.invoke('erp:dictionary:upsert', args),
    cardsList: async (moduleName: 'parts' | 'tools' | 'employees') => ipcRenderer.invoke('erp:cards:list', moduleName),
    cardsUpsert: async (args: {
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
    }) => ipcRenderer.invoke('erp:cards:upsert', args),
    documentsList: async (args?: { status?: string; docType?: string }) => ipcRenderer.invoke('erp:documents:list', args),
    documentsCreate: async (args: {
      docType: string;
      docNo: string;
      docDate?: number;
      departmentId?: string | null;
      authorId?: string | null;
      payloadJson?: string | null;
      lines: Array<{ partCardId?: string | null; qty: number; price?: number | null; payloadJson?: string | null }>;
    }) => ipcRenderer.invoke('erp:documents:create', args),
    documentsPost: async (documentId: string) => ipcRenderer.invoke('erp:documents:post', documentId),
  },
  warehouse: {
    lookupsGet: async () => ipcRenderer.invoke('warehouse:lookups:get'),
    analyticsEngineOutput: async (args?: { metric?: string; bucket?: string; from?: string; to?: string; workshopId?: string }) =>
      ipcRenderer.invoke('warehouse:analytics:engineOutput', args),
    nomenclatureItemTypesList: async () => ipcRenderer.invoke('warehouse:nomenclature:itemTypes:list'),
    nomenclatureItemTypeUpsert: async (args: Record<string, unknown>) => ipcRenderer.invoke('warehouse:nomenclature:itemTypes:upsert', args),
    nomenclatureItemTypeDelete: async (id: string) => ipcRenderer.invoke('warehouse:nomenclature:itemTypes:delete', id),
    nomenclaturePropertiesList: async () => ipcRenderer.invoke('warehouse:nomenclature:properties:list'),
    nomenclaturePropertyUpsert: async (args: Record<string, unknown>) => ipcRenderer.invoke('warehouse:nomenclature:properties:upsert', args),
    nomenclaturePropertyDelete: async (id: string) => ipcRenderer.invoke('warehouse:nomenclature:properties:delete', id),
    nomenclatureTemplatesList: async () => ipcRenderer.invoke('warehouse:nomenclature:templates:list'),
    nomenclatureTemplateUpsert: async (args: Record<string, unknown>) => ipcRenderer.invoke('warehouse:nomenclature:templates:upsert', args),
    nomenclatureTemplateDelete: async (id: string) => ipcRenderer.invoke('warehouse:nomenclature:templates:delete', id),
    nomenclatureList: async (args?: {
      id?: string;
      search?: string;
      itemType?: string;
      directoryKind?: string;
      directoryRefId?: string;
      groupId?: string;
      isActive?: boolean;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke('warehouse:nomenclature:list', args),
    nomenclatureGroupCounts: async (args?: { search?: string; itemType?: string; directoryKind?: string }) =>
      ipcRenderer.invoke('warehouse:nomenclature:groupCounts', args),
    stockBalancesByWorkshop: async (args: { workshopId: string; nomenclatureIds: string[] }) =>
      ipcRenderer.invoke('warehouse:stockBalancesByWorkshop', args),
    nomenclatureUpsert: async (args: Record<string, unknown>) => ipcRenderer.invoke('warehouse:nomenclature:upsert', args),
    nomenclatureDelete: async (id: string) => ipcRenderer.invoke('warehouse:nomenclature:delete', id),
    nomenclaturePartSpecsList: async (args?: { templateId?: string; engineBrandId?: string }) =>
      ipcRenderer.invoke('warehouse:nomenclature:partSpecs:list', args),
    nomenclaturePartSpecGet: async (args: { nomenclatureId: string }) => ipcRenderer.invoke('warehouse:nomenclature:partSpec:get', args),
    nomenclaturePartSpecUpdate: async (args: { nomenclatureId: string; spec: Record<string, unknown>; metadata?: PartMetadata }) =>
      ipcRenderer.invoke('warehouse:nomenclature:partSpec:update', args),
    nomenclatureDirectoryPartCreate: async (args: { name: string; code?: string | null }) =>
      ipcRenderer.invoke('warehouse:directoryPart:create', args),
    partsDedupeAnalyze: async () => ipcRenderer.invoke('warehouse:partsDedupe:analyze'),
    partsDedupeMerge: async (args: { survivorId: string; mergedIds: string[] }) =>
      ipcRenderer.invoke('warehouse:partsDedupe:merge', args),
    stockList: async (args?: {
      warehouseId?: string;
      nomenclatureId?: string;
      search?: string;
      lowStockOnly?: boolean;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke('warehouse:stock:list', args),
    documentsList: async (args?: {
      status?: string;
      docType?: string;
      excludeCancelled?: boolean;
      statusIn?: string[];
      fromDate?: number;
      toDate?: number;
      search?: string;
      warehouseId?: string;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke('warehouse:documents:list', args),
    documentGet: async (id: string) => ipcRenderer.invoke('warehouse:documents:get', id),
    documentCreate: async (args: Record<string, unknown>) => ipcRenderer.invoke('warehouse:documents:create', args),
    documentPlan: async (id: string) => ipcRenderer.invoke('warehouse:documents:plan', id),
    documentPost: async (id: string) => ipcRenderer.invoke('warehouse:documents:post', id),
    repairFundIntake: async (args: { engineId: string; items: Array<{ partId: string; partLabel: string; qty: number }> }) =>
      ipcRenderer.invoke('warehouse:repairFund:intake', args),
    repairFundIntakePreview: async (args: { engineId: string; items: Array<{ partId: string; partLabel: string; qty: number }> }) =>
      ipcRenderer.invoke('warehouse:repairFund:intakePreview', args),
    repairFundCaptureInstances: async (args: {
      engineId: string;
      instances: Array<{ partId: string; partLabel: string; stampedNumber: string; classification: string }>;
    }) => ipcRenderer.invoke('warehouse:repairFund:captureInstances', args),
    repairFundSetInstanceRepaired: async (args: { operationId: string; repaired: boolean }) =>
      ipcRenderer.invoke('warehouse:repairFund:setInstanceRepaired', args),
    documentCancel: async (id: string) => ipcRenderer.invoke('warehouse:documents:cancel', id),
    assemblyBomList: async (args?: { engineBrandId?: string; engineBrandIds?: string[]; engineNomenclatureId?: string; status?: string }) =>
      ipcRenderer.invoke('warehouse:assemblyBom:list', args),
    assemblyBomSchemaGet: async () => ipcRenderer.invoke('warehouse:assemblyBom:schema:get'),
    assemblyBomSchemaSet: async (args: { schema: unknown; renames?: Array<{ fromTypeId: string; toTypeId: string }> }) =>
      ipcRenderer.invoke('warehouse:assemblyBom:schema:set', args),
    assemblyBomSchemaUsageGet: async () => ipcRenderer.invoke('warehouse:assemblyBom:schema:usage:get'),
    assemblyBomGet: async (id: string) => ipcRenderer.invoke('warehouse:assemblyBom:get', id),
    assemblyBomUpsert: async (args: Record<string, unknown>) => ipcRenderer.invoke('warehouse:assemblyBom:upsert', args),
    assemblyBomDelete: async (id: string) => ipcRenderer.invoke('warehouse:assemblyBom:delete', id),
    assemblyBomActivateDefault: async (id: string) => ipcRenderer.invoke('warehouse:assemblyBom:activateDefault', id),
    assemblyBomArchive: async (id: string) => ipcRenderer.invoke('warehouse:assemblyBom:archive', id),
    assemblyBomHistory: async (args: { engineBrandId: string }) => ipcRenderer.invoke('warehouse:assemblyBom:history', args),
    assemblyBomPrint: async (id: string) => ipcRenderer.invoke('warehouse:assemblyBom:print', id),
    engineInstancesList: async (args?: { nomenclatureId?: string; contractId?: string; contractSectionNumber?: string; warehouseId?: string; status?: string; search?: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('warehouse:engineInstances:list', args),
    engineInstanceUpsert: async (args: { id?: string; nomenclatureId: string; serialNumber: string; contractId?: string | null; contractSectionNumber?: string | null; warehouseId?: string; currentStatus?: string }) =>
      ipcRenderer.invoke('warehouse:engineInstances:upsert', args),
    engineInstanceDelete: async (id: string) => ipcRenderer.invoke('warehouse:engineInstances:delete', id),
    contractSectionsGet: async (contractId: string) => ipcRenderer.invoke('warehouse:contracts:sections:get', contractId),
    movementsList: async (args?: { nomenclatureId?: string; warehouseId?: string; documentHeaderId?: string; fromDate?: number; toDate?: number; limit?: number }) =>
      ipcRenderer.invoke('warehouse:movements:list', args),
    forecastIncomingGet: async (args: { from: number; to: number; warehouseId?: string }) => ipcRenderer.invoke('warehouse:forecast:incoming:get', args),
    forecastBomGet: async (args: { engineBrandId: string; targetEnginesPerDay?: number; horizonDays?: number; warehouseIds?: string[] }) =>
      ipcRenderer.invoke('warehouse:forecast:bom:get', args),
  },
  files: {
    upload: async (args: { path: string; fileName?: string; scope?: { ownerType: string; ownerId: string; category: string } }) =>
      ipcRenderer.invoke('files:upload', args),
    pick: async () => ipcRenderer.invoke('files:pick'),
    download: async (args: { fileId: string }) => ipcRenderer.invoke('files:download', args),
    open: async (args: { fileId: string }) => ipcRenderer.invoke('files:open', args),
    delete: async (args: { fileId: string }) => ipcRenderer.invoke('files:delete', args),
    previewGet: async (args: { fileId: string }) => ipcRenderer.invoke('files:preview:get', args),
    originalGet: async (args: { fileId: string }) => ipcRenderer.invoke('files:original:get', args),
    copyImage: async (args: { fileId: string }) => ipcRenderer.invoke('files:clipboard:copyImage', args),
    copyToFolder: async (args: { fileIds: string[] }) => ipcRenderer.invoke('files:copyToFolder', args),
    revealForShare: async (args: { fileIds: string[]; label?: string; mailto?: boolean }) =>
      ipcRenderer.invoke('files:revealForShare', args),
    assemblePdf: async (args: { fileIds: string[]; defaultName?: string }) => ipcRenderer.invoke('files:assemblePdf', args),
    print: async (args: { fileIds: string[] }) => ipcRenderer.invoke('files:print', args),
    downloadDirGet: async () => ipcRenderer.invoke('files:downloadDir:get'),
    downloadDirPick: async () => ipcRenderer.invoke('files:downloadDir:pick'),
  },
  chat: {
    usersList: async () => ipcRenderer.invoke('chat:usersList'),
    list: async (args: { mode: 'global' | 'private'; withUserId?: string | null; limit?: number }) => ipcRenderer.invoke('chat:list', args),
    adminListPair: async (args: { userAId: string; userBId: string; limit?: number }) => ipcRenderer.invoke('chat:adminListPair', args),
    sendText: async (args: { recipientUserId?: string | null; text: string }) => ipcRenderer.invoke('chat:sendText', args),
    sendTextEverywhere: async (args: { recipientUserId?: string | null; text: string }) =>
      ipcRenderer.invoke('chat:sendTextEverywhere', args),
    sendFile: async (args: { recipientUserId?: string | null; path: string }) => ipcRenderer.invoke('chat:sendFile', args),
    sendDeepLink: async (args: { recipientUserId?: string | null; link: unknown }) => ipcRenderer.invoke('chat:sendDeepLink', args),
    markRead: async (args: { messageIds: string[] }) => ipcRenderer.invoke('chat:markRead', args),
    unreadCount: async () => ipcRenderer.invoke('chat:unreadCount'),
    export: async (args: { startMs: number; endMs: number }) => ipcRenderer.invoke('chat:export', args),
    deleteMessage: async (args: { messageId: string }) => ipcRenderer.invoke('chat:deleteMessage', args),
  },
  notes: {
    usersList: async () => ipcRenderer.invoke('notes:usersList'),
    list: async () => ipcRenderer.invoke('notes:list'),
    upsert: async (args: {
      id?: string;
      title: string;
      body: Array<{ id: string; kind: string }>;
      importance: 'normal' | 'important' | 'burning' | 'later';
      dueAt?: number | null;
      sortOrder?: number;
    }) => ipcRenderer.invoke('notes:upsert', args),
    delete: async (args: { noteId: string }) => ipcRenderer.invoke('notes:delete', args),
    share: async (args: { noteId: string; recipientUserId: string }) => ipcRenderer.invoke('notes:share', args),
    unshare: async (args: { noteId: string; recipientUserId: string }) => ipcRenderer.invoke('notes:unshare', args),
    hide: async (args: { noteId: string; hidden: boolean }) => ipcRenderer.invoke('notes:hide', args),
    reorder: async (args: { noteId: string; sortOrder: number }) => ipcRenderer.invoke('notes:reorder', args),
    burningCount: async () => ipcRenderer.invoke('notes:burningCount'),
  },
  aiAgent: {
    assist: async (args: unknown) => ipcRenderer.invoke('ai:assist', args),
    logEvent: async (args: unknown) => ipcRenderer.invoke('ai:log', args),
    conversationsList: async (args?: { limit?: number }) =>
      ipcRenderer.invoke('ai:conversations:list', args ?? {}),
    conversationMessages: async (args: { conversationId: string; limit?: number }) =>
      ipcRenderer.invoke('ai:conversations:get', args),
    conversationDelete: async (args: { conversationId: string }) =>
      ipcRenderer.invoke('ai:conversations:delete', args),
    conversationSearch: async (args: { conversationId: string; query: string; limit?: number }) =>
      ipcRenderer.invoke('ai:conversations:search', args),
    assistStream: async (args: unknown, onEvent: (ev: unknown) => void) => {
      const channelId = `ai:assist:stream:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const listener = (_e: unknown, ev: unknown) => {
        try {
          onEvent(ev);
        } catch {
          // ignore listener errors so they don't kill the stream
        }
      };
      ipcRenderer.on(channelId, listener);
      try {
        return await ipcRenderer.invoke('ai:assist:stream', { channelId, args });
      } finally {
        ipcRenderer.removeListener(channelId, listener);
      }
    },
  },
  logging: {
    getConfig: async () => ipcRenderer.invoke('logging:getConfig'),
    setEnabled: async (enabled: boolean) => ipcRenderer.invoke('logging:setEnabled', enabled),
    setMode: async (mode: 'dev' | 'prod') => ipcRenderer.invoke('logging:setMode', mode),
  },
  settings: {
    uiGet: async (args?: { userId?: string }) => ipcRenderer.invoke('ui:prefs:get', args),
    uiSet: async (args: {
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
      shellPrefs?: unknown;
    }) =>
      ipcRenderer.invoke('ui:prefs:set', args),
    uiControlGet: async () => ipcRenderer.invoke('ui:control:get'),
    uiControlSetGlobal: async (args: { uiSettings: unknown; bumpVersion?: boolean }) => ipcRenderer.invoke('ui:control:setGlobal', args),
    releaseWelcomeGet: async () => ipcRenderer.invoke('ui:releaseWelcome:get'),
    releaseWelcomeAcknowledge: async () => ipcRenderer.invoke('ui:releaseWelcome:acknowledge'),
  },
  shortcuts: {
    get: async (args: { userId: string }) => ipcRenderer.invoke('shortcuts:get', args),
    set: async (args: { userId: string; ids: string[] }) => ipcRenderer.invoke('shortcuts:set', args),
  },
  e2eKeys: {
    status: async () => ipcRenderer.invoke('e2e:keys:status'),
    export: async () => ipcRenderer.invoke('e2e:keys:export'),
    rotate: async () => ipcRenderer.invoke('e2e:keys:rotate'),
  },
  backups: {
    status: async () => ipcRenderer.invoke('backups:status'),
    nightlyList: async () => ipcRenderer.invoke('backups:nightly:list'),
    nightlyEnter: async (args: { date: string }) => ipcRenderer.invoke('backups:nightly:enter', args),
    nightlyRunNow: async () => ipcRenderer.invoke('backups:nightly:runNow'),
    exit: async () => ipcRenderer.invoke('backups:exit'),
  },
};

contextBridge.exposeInMainWorld('matrica', matricaApi);


