import { contextBridge, ipcRenderer } from 'electron';

type StartupStatusState = { stage: string; note: string };

const startupApi = {
  onStage: (handler: (state: StartupStatusState) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: StartupStatusState) => handler(payload);
    ipcRenderer.on('startup:stage', wrapped);
    return () => ipcRenderer.removeListener('startup:stage', wrapped);
  },
};

contextBridge.exposeInMainWorld('matricaStartup', startupApi);
