import { contextBridge, ipcRenderer } from 'electron';

// API, доступный в renderer. Дальше будем расширять CRUD и синхронизацию.
contextBridge.exposeInMainWorld('matrica', {
  ping: async () => ipcRenderer.invoke('app:ping'),
  app: {
    version: async () => ipcRenderer.invoke('app:version'),
  },
  log: {
    send: async (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      ipcRenderer.invoke('log:send', { level, message }),
  },
  auth: {
    status: async () => ipcRenderer.invoke('auth:status'),
    sync: async () => ipcRenderer.invoke('auth:sync'),
    login: async (args: { username: string; password: string }) => ipcRenderer.invoke('auth:login', args),
    logout: async (args: { refreshToken?: string }) => ipcRenderer.invoke('auth:logout', args),
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
  },
  sync: {
    run: async () => ipcRenderer.invoke('sync:run'),
    status: async () => ipcRenderer.invoke('sync:status'),
    configGet: async () => ipcRenderer.invoke('sync:config:get'),
    configSet: async (args: { apiBaseUrl: string }) => ipcRenderer.invoke('sync:config:set', args),
  },
  server: {
    health: async () => ipcRenderer.invoke('server:health'),
  },
  reports: {
    periodStagesCsv: async (args: { startMs?: number; endMs: number }) => ipcRenderer.invoke('reports:periodStagesCsv', args),
    periodStagesByLinkCsv: async (args: { startMs?: number; endMs: number; linkAttrCode: string }) =>
      ipcRenderer.invoke('reports:periodStagesByLinkCsv', args),
  },
  admin: {
    entityTypes: {
      list: async () => ipcRenderer.invoke('admin:entityTypes:list'),
      upsert: async (args: { id?: string; code: string; name: string }) => ipcRenderer.invoke('admin:entityTypes:upsert', args),
      deleteInfo: async (entityTypeId: string) => ipcRenderer.invoke('admin:entityTypes:deleteInfo', entityTypeId),
      delete: async (args: { entityTypeId: string; deleteEntities: boolean; deleteDefs: boolean }) =>
        ipcRenderer.invoke('admin:entityTypes:delete', args),
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
      deleteInfo: async (entityId: string) => ipcRenderer.invoke('admin:entities:deleteInfo', entityId),
      detachLinksAndDelete: async (entityId: string) => ipcRenderer.invoke('admin:entities:detachLinksAndDelete', entityId),
      softDelete: async (entityId: string) => ipcRenderer.invoke('admin:entities:softDelete', entityId),
    },
    users: {
      list: async () => ipcRenderer.invoke('admin:users:list'),
      create: async (args: { username: string; password: string; role: string }) => ipcRenderer.invoke('admin:users:create', args),
      update: async (userId: string, args: { role?: string; isActive?: boolean; password?: string }) =>
        ipcRenderer.invoke('admin:users:update', userId, args),
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
  },
  update: {
    check: async () => ipcRenderer.invoke('update:check'),
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
  parts: {
    list: async (args?: { q?: string; limit?: number }) => ipcRenderer.invoke('parts:list', args),
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
    delete: async (partId: string) => ipcRenderer.invoke('parts:delete', partId),
    getFiles: async (partId: string) => ipcRenderer.invoke('parts:getFiles', partId),
  },
  files: {
    upload: async (args: { path: string; scope?: { ownerType: string; ownerId: string; category: string } }) => ipcRenderer.invoke('files:upload', args),
    pick: async () => ipcRenderer.invoke('files:pick'),
    download: async (args: { fileId: string }) => ipcRenderer.invoke('files:download', args),
    open: async (args: { fileId: string }) => ipcRenderer.invoke('files:open', args),
    delete: async (args: { fileId: string }) => ipcRenderer.invoke('files:delete', args),
    downloadDirGet: async () => ipcRenderer.invoke('files:downloadDir:get'),
    downloadDirPick: async () => ipcRenderer.invoke('files:downloadDir:pick'),
  },
  logging: {
    getEnabled: async () => ipcRenderer.invoke('logging:getEnabled'),
    setEnabled: async (enabled: boolean) => ipcRenderer.invoke('logging:setEnabled', enabled),
  },
});


