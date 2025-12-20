import { ipcMain } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { createEngine, getEngineDetails, listEngines, setEngineAttribute } from '../services/engineService.js';
import { addOperation, listOperations } from '../services/operationService.js';
import { listAudit } from '../services/auditService.js';
import { runSync } from '../services/syncService.js';
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../services/updateService.js';

export function registerIpc(db: BetterSQLite3Database, opts: { clientId: string; apiBaseUrl: string }) {
  ipcMain.handle('engine:list', async () => listEngines(db));
  ipcMain.handle('engine:create', async () => createEngine(db));
  ipcMain.handle('engine:get', async (_e, id: string) => getEngineDetails(db, id));
  ipcMain.handle('engine:setAttr', async (_e, engineId: string, code: string, value: unknown) =>
    setEngineAttribute(db, engineId, code, value),
  );

  ipcMain.handle('ops:list', async (_e, engineId: string) => listOperations(db, engineId));
  ipcMain.handle('ops:add', async (_e, engineId: string, operationType: string, status: string, note?: string) =>
    addOperation(db, engineId, operationType, status, note),
  );

  ipcMain.handle('audit:list', async () => listAudit(db));

  ipcMain.handle('sync:run', async () => runSync(db, opts.clientId, opts.apiBaseUrl));

  ipcMain.handle('update:check', async () => checkForUpdates());
  ipcMain.handle('update:download', async () => downloadUpdate());
  ipcMain.handle('update:install', async () => quitAndInstall());
}


