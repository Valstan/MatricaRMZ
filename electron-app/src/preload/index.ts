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
    register: async (args: { login: string; password: string; fullName: string; position: string }) =>
      ipcRenderer.invoke('auth:register', args),
    logout: async (args: { refreshToken?: string }) => ipcRenderer.invoke('auth:logout', args),
    changePassword: async (args: { currentPassword: string; newPassword: string }) => ipcRenderer.invoke('auth:changePassword', args),
    profileGet: async () => ipcRenderer.invoke('auth:profileGet'),
    profileUpdate: async (args: { fullName?: string | null; position?: string | null; sectionName?: string | null }) =>
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
  },
  changes: {
    list: async (args?: { status?: string; limit?: number }) => ipcRenderer.invoke('changes:list', args),
    apply: async (args: { id: string }) => ipcRenderer.invoke('changes:apply', args),
    reject: async (args: { id: string }) => ipcRenderer.invoke('changes:reject', args),
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
      create: async (args: { login: string; password: string; role: string; fullName?: string; accessEnabled?: boolean }) =>
        ipcRenderer.invoke('admin:users:create', args),
      update: async (userId: string, args: { role?: string; accessEnabled?: boolean; password?: string; login?: string; fullName?: string }) =>
        ipcRenderer.invoke('admin:users:update', userId, args),
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
  },
  employees: {
    list: async () => ipcRenderer.invoke('employees:list'),
    get: async (id: string) => ipcRenderer.invoke('employees:get', id),
    create: async () => ipcRenderer.invoke('employees:create'),
    setAttr: async (employeeId: string, code: string, value: unknown) =>
      ipcRenderer.invoke('employees:setAttr', employeeId, code, value),
    delete: async (employeeId: string) => ipcRenderer.invoke('employees:delete', employeeId),
    merge: async () => ipcRenderer.invoke('employees:merge'),
    departmentsList: async () => ipcRenderer.invoke('employees:departments:list'),
    defs: async () => ipcRenderer.invoke('employees:defs'),
    permissionsGet: async (userId: string) => ipcRenderer.invoke('employees:permissionsGet', userId),
  },
  update: {
    check: async () => ipcRenderer.invoke('update:check'),
    status: async () => ipcRenderer.invoke('update:status'),
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
    previewGet: async (args: { fileId: string }) => ipcRenderer.invoke('files:preview:get', args),
    downloadDirGet: async () => ipcRenderer.invoke('files:downloadDir:get'),
    downloadDirPick: async () => ipcRenderer.invoke('files:downloadDir:pick'),
  },
  chat: {
    usersList: async () => ipcRenderer.invoke('chat:usersList'),
    list: async (args: { mode: 'global' | 'private'; withUserId?: string | null; limit?: number }) => ipcRenderer.invoke('chat:list', args),
    adminListPair: async (args: { userAId: string; userBId: string; limit?: number }) => ipcRenderer.invoke('chat:adminListPair', args),
    sendText: async (args: { recipientUserId?: string | null; text: string }) => ipcRenderer.invoke('chat:sendText', args),
    sendFile: async (args: { recipientUserId?: string | null; path: string }) => ipcRenderer.invoke('chat:sendFile', args),
    sendDeepLink: async (args: { recipientUserId?: string | null; link: unknown }) => ipcRenderer.invoke('chat:sendDeepLink', args),
    markRead: async (args: { messageIds: string[] }) => ipcRenderer.invoke('chat:markRead', args),
    unreadCount: async () => ipcRenderer.invoke('chat:unreadCount'),
    export: async (args: { startMs: number; endMs: number }) => ipcRenderer.invoke('chat:export', args),
    deleteMessage: async (args: { messageId: string }) => ipcRenderer.invoke('chat:deleteMessage', args),
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
    uiSet: async (args: { theme?: string; chatSide?: string; userId?: string; tabsLayout?: { order?: string[]; hidden?: string[]; trashIndex?: number | null } | null }) =>
      ipcRenderer.invoke('ui:prefs:set', args),
  },
  backups: {
    status: async () => ipcRenderer.invoke('backups:status'),
    nightlyList: async () => ipcRenderer.invoke('backups:nightly:list'),
    nightlyEnter: async (args: { date: string }) => ipcRenderer.invoke('backups:nightly:enter', args),
    nightlyRunNow: async () => ipcRenderer.invoke('backups:nightly:runNow'),
    exit: async () => ipcRenderer.invoke('backups:exit'),
  },
});


