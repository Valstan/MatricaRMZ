import { contextBridge, ipcRenderer } from 'electron';

type UpdateState = {
  message: string;
  pct: number;
  version: string;
  logs: string[];
};

const updateApi = {
  onState: (handler: (state: UpdateState) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: UpdateState) => handler(payload);
    ipcRenderer.on('update:state', wrapped);
    return () => ipcRenderer.removeListener('update:state', wrapped);
  },
};

contextBridge.exposeInMainWorld('matricaUpdate', updateApi);
