import { contextBridge, ipcRenderer } from 'electron';

// API, доступный в renderer. Дальше будем расширять CRUD и синхронизацию.
contextBridge.exposeInMainWorld('matrica', {
  ping: async () => ipcRenderer.invoke('app:ping'),
  log: {
    send: async (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      ipcRenderer.invoke('log:send', { level, message }),
  },
  auth: {
    status: async () => ipcRenderer.invoke('auth:status'),
    login: async (args: { username: string; password: string }) => ipcRenderer.invoke('auth:login', args),
    logout: async (args: { refreshToken?: string }) => ipcRenderer.invoke('auth:logout', args),
  },
  engines: {
    list: async () => ipcRenderer.invoke('engine:list'),
    create: async () => ipcRenderer.invoke('engine:create'),
    get: async (id: string) => ipcRenderer.invoke('engine:get', id),
    setAttr: async (engineId: string, code: string, value: unknown) =>
      ipcRenderer.invoke('engine:setAttr', engineId, code, value),
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
  reports: {
    periodStagesCsv: async (args: { startMs?: number; endMs: number }) => ipcRenderer.invoke('reports:periodStagesCsv', args),
    periodStagesByLinkCsv: async (args: { startMs?: number; endMs: number; linkAttrCode: string }) =>
      ipcRenderer.invoke('reports:periodStagesByLinkCsv', args),
  },
  admin: {
    entityTypes: {
      list: async () => ipcRenderer.invoke('admin:entityTypes:list'),
      upsert: async (args: { id?: string; code: string; name: string }) => ipcRenderer.invoke('admin:entityTypes:upsert', args),
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
    },
    entities: {
      listByEntityType: async (entityTypeId: string) => ipcRenderer.invoke('admin:entities:listByEntityType', entityTypeId),
      create: async (entityTypeId: string) => ipcRenderer.invoke('admin:entities:create', entityTypeId),
      get: async (id: string) => ipcRenderer.invoke('admin:entities:get', id),
      setAttr: async (entityId: string, code: string, value: unknown) => ipcRenderer.invoke('admin:entities:setAttr', entityId, code, value),
      softDelete: async (entityId: string) => ipcRenderer.invoke('admin:entities:softDelete', entityId),
    },
  },
  update: {
    check: async () => ipcRenderer.invoke('update:check'),
  },
});


