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
import { buildPeriodStagesCsv, buildPeriodStagesCsvByLink } from '../services/reportService.js';
import { checkForUpdates } from '../services/updateService.js';
import { authLogin, authLogout, authStatus, getSession } from '../services/authService.js';
import { createEntity, getEntityDetails, listEntitiesByType, setEntityAttribute, softDeleteEntity } from '../services/entityService.js';
import { getRepairChecklistForEngine, listRepairChecklistTemplates, saveRepairChecklistForEngine } from '../services/checklistService.js';
import {
  adminCreateUser,
  adminGetUserPermissions,
  adminListUsers,
  adminSetUserPermissions,
  adminUpdateUser,
} from '../services/adminUsersService.js';
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

  async function currentActor(): Promise<string> {
    const s = await getSession(db).catch(() => null);
    const u = s?.user?.username;
    return u && u.trim() ? u.trim() : 'local';
  }

  async function currentPermissions(): Promise<Record<string, boolean>> {
    const s = await getSession(db).catch(() => null);
    return (s?.permissions ?? {}) as Record<string, boolean>;
  }

  function hasPerm(perms: Record<string, boolean>, code: string): boolean {
    return perms?.[code] === true;
  }

  ipcMain.handle('log:send', async (_e, payload: { level: string; message: string }) => {
    logToFile(`renderer ${payload.level}: ${payload.message}`);
  });

  ipcMain.handle('engine:list', async () => listEngines(db));
  ipcMain.handle('engine:create', async () => createEngine(db, await currentActor()));
  ipcMain.handle('engine:get', async (_e, id: string) => getEngineDetails(db, id));
  ipcMain.handle('engine:setAttr', async (_e, engineId: string, code: string, value: unknown) =>
    setEngineAttribute(db, engineId, code, value, await currentActor()),
  );

  ipcMain.handle('ops:list', async (_e, engineId: string) => listOperations(db, engineId));
  ipcMain.handle('ops:add', async (_e, engineId: string, operationType: string, status: string, note?: string) =>
    addOperation(db, engineId, operationType, status, note, await currentActor()),
  );

  ipcMain.handle('audit:list', async () => listAudit(db));

  ipcMain.handle('auth:status', async () => authStatus(db));
  ipcMain.handle('auth:login', async (_e, args: { username: string; password: string }) =>
    authLogin(db, { apiBaseUrl: mgr.getApiBaseUrl(), username: args.username, password: args.password }),
  );
  ipcMain.handle('auth:logout', async (_e, args: { refreshToken?: string }) =>
    authLogout(db, { apiBaseUrl: mgr.getApiBaseUrl(), refreshToken: args.refreshToken }),
  );

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
  ipcMain.handle('reports:periodStagesByLinkCsv', async (_e, args: { startMs?: number; endMs: number; linkAttrCode: string }) =>
    buildPeriodStagesCsvByLink(db, args),
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

  ipcMain.handle('admin:entities:listByEntityType', async (_e, entityTypeId: string) => listEntitiesByType(db, entityTypeId));
  ipcMain.handle('admin:entities:create', async (_e, entityTypeId: string) => createEntity(db, entityTypeId));
  ipcMain.handle('admin:entities:get', async (_e, id: string) => getEntityDetails(db, id));
  ipcMain.handle('admin:entities:setAttr', async (_e, entityId: string, code: string, value: unknown) =>
    setEntityAttribute(db, entityId, code, value),
  );
  ipcMain.handle('admin:entities:softDelete', async (_e, entityId: string) => softDeleteEntity(db, entityId));

  ipcMain.handle('admin:users:list', async () => adminListUsers(db, mgr.getApiBaseUrl()));
  ipcMain.handle('admin:users:create', async (_e, args: { username: string; password: string; role: string }) =>
    adminCreateUser(db, mgr.getApiBaseUrl(), args),
  );
  ipcMain.handle('admin:users:update', async (_e, userId: string, args: { role?: string; isActive?: boolean; password?: string }) =>
    adminUpdateUser(db, mgr.getApiBaseUrl(), userId, args),
  );
  ipcMain.handle('admin:users:permissionsGet', async (_e, userId: string) => adminGetUserPermissions(db, mgr.getApiBaseUrl(), userId));
  ipcMain.handle('admin:users:permissionsSet', async (_e, userId: string, set: Record<string, boolean>) =>
    adminSetUserPermissions(db, mgr.getApiBaseUrl(), userId, set),
  );

  ipcMain.handle('update:check', async () => checkForUpdates());

  // -----------------------------
  // Repair checklist
  // -----------------------------
  ipcMain.handle('checklists:templates:list', async (_e, args?: { stage?: string }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'operations.view')) return { ok: false, error: 'permission denied: operations.view' };
    return listRepairChecklistTemplates(db, args?.stage);
  });

  ipcMain.handle('checklists:engine:get', async (_e, args: { engineId: string; stage: string }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'operations.view')) return { ok: false, error: 'permission denied: operations.view' };
    const t = await listRepairChecklistTemplates(db, args.stage);
    if (!t.ok) return t;
    const r = await getRepairChecklistForEngine(db, args.engineId, args.stage);
    if (!r.ok) return r;
    return { ok: true as const, operationId: r.operationId, payload: r.payload, templates: t.templates };
  });

  ipcMain.handle(
    'checklists:engine:save',
    async (
      _e,
      args: { engineId: string; stage: string; templateId: string; operationId?: string | null; answers: any },
    ) => {
      const perms = await currentPermissions();
      if (!hasPerm(perms, 'operations.edit')) return { ok: false, error: 'permission denied: operations.edit' };

      const t = await listRepairChecklistTemplates(db, args.stage);
      if (!t.ok) return t;
      const tmpl = t.templates.find((x) => x.id === args.templateId) ?? null;
      if (!tmpl) return { ok: false, error: 'template not found' };

      const actor = await currentActor();
      const payload = {
        kind: 'repair_checklist' as const,
        templateId: tmpl.id,
        templateVersion: tmpl.version,
        stage: args.stage,
        engineEntityId: args.engineId,
        filledBy: actor || null,
        filledAt: Date.now(),
        answers: args.answers ?? {},
      };

      return saveRepairChecklistForEngine(db, { engineId: args.engineId, stage: args.stage, operationId: args.operationId, payload, actor });
    },
  );
}


