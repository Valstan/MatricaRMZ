import { contextBridge, ipcRenderer } from 'electron';

type UpdateStage = 'checking' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'uptodate' | 'error';
type UpdateState = {
  message: string;
  pct: number;
  version: string;
  logs: string[];
  stage?: UpdateStage;
  transferredBytes?: number | null;
  totalBytes?: number | null;
  bytesPerSecond?: number | null;
  etaSeconds?: number | null;
  versionFromLabel?: string;
  versionToLabel?: string;
  errorText?: string | null;
};

const updateApi = {
  onState: (handler: (state: UpdateState) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: UpdateState) => handler(payload);
    ipcRenderer.on('update:state', wrapped);
    return () => ipcRenderer.removeListener('update:state', wrapped);
  },
};

contextBridge.exposeInMainWorld('matricaUpdate', updateApi);
