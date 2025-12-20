import { contextBridge, ipcRenderer } from 'electron';

// API, доступный в renderer. Дальше будем расширять CRUD и синхронизацию.
contextBridge.exposeInMainWorld('matrica', {
  ping: async () => ipcRenderer.invoke('app:ping'),
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
  },
  update: {
    check: async () => ipcRenderer.invoke('update:check'),
    download: async () => ipcRenderer.invoke('update:download'),
    install: async () => ipcRenderer.invoke('update:install'),
  },
});


