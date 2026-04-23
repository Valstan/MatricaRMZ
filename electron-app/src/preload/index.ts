import { contextBridge, ipcRenderer } from 'electron';
import type { ChatDeepLinkPayload } from '@matricarmz/shared';

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
  log: {
    send: async (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      ipcRenderer.invoke('log:send', { level, message }),
  },
  auth: {
    status: async () => ipcRenderer.invoke('auth:status'),
    sync: async () => ipcRenderer.invoke('auth:sync'),
    login: async (args: { username: string; password: string }) => ipcRenderer.invoke('auth:login', args),
    loginOptions: async () => ipcRenderer.invoke('auth:loginOptions'),
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
    delete: async (engineId: string) => ipcRenderer.invoke('engine:delete', engineId),
  },
  operations: {
    list: async (engineId: string) => ipcRenderer.invoke('ops:list', engineId),
    add: async (engineId: string, operationType: string, status: string, note?: string) =>
      ipcRenderer.invoke('ops:add', engineId, operationType, status, note),
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
      get: async (id: string) => ipcRenderer.invoke('admin:entities:get', id),
      setAttr: async (entityId: string, code: string, value: unknown) => ipcRenderer.invoke('admin:entities:setAttr', entityId, code, value),
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
  },
  supplyRequests: {
    list: async (args?: { q?: string; month?: string }) => ipcRenderer.invoke('supplyRequests:list', args),
    get: async (id: string) => ipcRenderer.invoke('supplyRequests:get', id),
    create: async () => ipcRenderer.invoke('supplyRequests:create'),
    update: async (args: { id: string; payload: unknown }) => ipcRenderer.invoke('supplyRequests:update', args),
    delete: async (id: string) => ipcRenderer.invoke('supplyRequests:delete', id),
    transition: async (args: { id: string; action: string; note?: string | null }) => ipcRenderer.invoke('supplyRequests:transition', args),
  },
  workOrders: {
    list: async (args?: { q?: string; month?: string }) => ipcRenderer.invoke('workOrders:list', args),
    get: async (id: string) => ipcRenderer.invoke('workOrders:get', id),
    create: async () => ipcRenderer.invoke('workOrders:create'),
    update: async (args: { id: string; payload: unknown }) => ipcRenderer.invoke('workOrders:update', args),
    delete: async (id: string) => ipcRenderer.invoke('workOrders:delete', id),
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
    templates: {
      list: async (args?: { q?: string; limit?: number; offset?: number }) => ipcRenderer.invoke('parts:templates:list', args),
      get: async (templateId: string) => ipcRenderer.invoke('parts:templates:get', templateId),
      create: async (args?: { attributes?: Record<string, unknown> }) => ipcRenderer.invoke('parts:templates:create', args),
      updateAttribute: async (args: { templateId: string; attributeCode: string; value: unknown }) =>
        ipcRenderer.invoke('parts:templates:updateAttribute', args),
      delete: async (templateId: string) => ipcRenderer.invoke('parts:templates:delete', templateId),
    },
    createFromTemplate: async (args: { templateId: string; attributes?: Record<string, unknown> }) =>
      ipcRenderer.invoke('parts:createFromTemplate', args),
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
      groupId?: string;
      isActive?: boolean;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke('warehouse:nomenclature:list', args),
    nomenclatureUpsert: async (args: Record<string, unknown>) => ipcRenderer.invoke('warehouse:nomenclature:upsert', args),
    nomenclatureDelete: async (id: string) => ipcRenderer.invoke('warehouse:nomenclature:delete', id),
    nomenclatureEngineBrandsList: async (args: { nomenclatureId: string }) => ipcRenderer.invoke('warehouse:nomenclature:engineBrands:list', args),
    nomenclatureEngineBrandUpsert: async (args: Record<string, unknown>) => ipcRenderer.invoke('warehouse:nomenclature:engineBrands:upsert', args),
    nomenclatureEngineBrandDelete: async (id: string) => ipcRenderer.invoke('warehouse:nomenclature:engineBrands:delete', id),
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
    documentCancel: async (id: string) => ipcRenderer.invoke('warehouse:documents:cancel', id),
    assemblyBomList: async (args?: { engineBrandId?: string; engineNomenclatureId?: string; status?: string }) =>
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
    engineInstancesList: async (args?: { nomenclatureId?: string; contractId?: string; warehouseId?: string; status?: string; search?: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('warehouse:engineInstances:list', args),
    engineInstanceUpsert: async (args: Record<string, unknown>) => ipcRenderer.invoke('warehouse:engineInstances:upsert', args),
    engineInstanceDelete: async (id: string) => ipcRenderer.invoke('warehouse:engineInstances:delete', id),
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
    ollamaHealth: async (args: unknown) => ipcRenderer.invoke('ai:ollama-health', args),
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


