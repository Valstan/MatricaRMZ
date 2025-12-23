import { ipcMain } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

import { createEngine, getEngineDetails, listEngines, setEngineAttribute } from '../services/engineService.js';
import { addOperation, listOperations } from '../services/operationService.js';
import { listAudit } from '../services/auditService.js';
import { SyncManager } from '../services/syncManager.js';
import { listAttributeDefsByEntityType, listEntityTypes, upsertAttributeDef, upsertEntityType } from '../services/adminService.js';
import { buildPeriodStagesCsv } from '../services/reportService.js';
import { checkForUpdates } from '../services/updateService.js';
import { syncState } from '../database/schema.js';

export function registerIpc(db: BetterSQLite3Database, opts: { clientId: string; apiBaseUrl: string }) {
  function logToFile(message: string) {
    try {
      const dir = app.getPath('userData');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'matricarmz.log'), `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // ignore
    }
  }

  // Один менеджер на процесс (переиспользуем и для ручного sync, и для status).
  const mgr = new SyncManager(db, opts.clientId, opts.apiBaseUrl);
  mgr.startAuto(5 * 60_000);

  ipcMain.handle('log:send', async (_e, payload: { level: string; message: string }) => {
    logToFile(`renderer ${payload.level}: ${payload.message}`);
  });

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

  ipcMain.handle('sync:run', async () => mgr.runOnce());
  ipcMain.handle('sync:status', async () => mgr.getStatus());
  ipcMain.handle('sync:config:get', async () => {
    try {
      const row = await db.select().from(syncState).where(eq(syncState.key, 'apiBaseUrl')).limit(1);
      return { ok: true, apiBaseUrl: row[0]?.value ?? mgr.getApiBaseUrl() };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  ipcMain.handle('sync:config:set', async (_e, args: { apiBaseUrl: string }) => {
    try {
      const v = String(args.apiBaseUrl ?? '').trim();
      if (!v) return { ok: false, error: 'apiBaseUrl is empty' };
      const ts = Date.now();
      await db
        .insert(syncState)
        .values({ key: 'apiBaseUrl', value: v, updatedAt: ts })
        .onConflictDoUpdate({ target: syncState.key, set: { value: v, updatedAt: ts } });
      mgr.setApiBaseUrl(v);
      logToFile(`sync apiBaseUrl set: ${v}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('reports:periodStagesCsv', async (_e, args: { startMs?: number; endMs: number }) =>
    buildPeriodStagesCsv(db, args),
  );

  ipcMain.handle('admin:entityTypes:list', async () => listEntityTypes(db));
  ipcMain.handle('admin:entityTypes:upsert', async (_e, args: { id?: string; code: string; name: string }) =>
    upsertEntityType(db, args),
  );
  ipcMain.handle('admin:attributeDefs:listByEntityType', async (_e, entityTypeId: string) =>
    listAttributeDefsByEntityType(db, entityTypeId),
  );
  ipcMain.handle(
    'admin:attributeDefs:upsert',
    async (
      _e,
      args: {
        id?: string;
        entityTypeId: string;
        code: string;
        name: string;
        dataType: string;
        isRequired?: boolean;
        sortOrder?: number;
        metaJson?: string | null;
      },
    ) => upsertAttributeDef(db, args),
  );

  ipcMain.handle('update:check', async () => checkForUpdates());
}


