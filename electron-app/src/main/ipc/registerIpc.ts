import { ipcMain, dialog } from 'electron';
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
import { authLogin, authLogout, authStatus, authSync, getSession } from '../services/authService.js';
import { createEntity, getEntityDetails, listEntitiesByType, setEntityAttribute, softDeleteEntity } from '../services/entityService.js';
import { getRepairChecklistForEngine, listRepairChecklistTemplates, saveRepairChecklistForEngine } from '../services/checklistService.js';
import { createSupplyRequest, getSupplyRequest, listSupplyRequests, transitionSupplyRequest, updateSupplyRequest } from '../services/supplyRequestService.js';
import { filesDelete, filesDownload, filesDownloadDirGet, filesDownloadDirSet, filesOpen, filesUpload } from '../services/fileService.js';
import { partsCreate, partsDelete, partsGet, partsGetFiles, partsList, partsUpdateAttribute } from '../services/partsService.js';
import {
  adminCreateUser,
  adminGetUserPermissions,
  adminListUserDelegations,
  adminListUsers,
  adminCreateDelegation,
  adminRevokeDelegation,
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
  ipcMain.handle('auth:sync', async () => authSync(db, { apiBaseUrl: mgr.getApiBaseUrl() }));
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

  ipcMain.handle('admin:users:delegationsList', async (_e, userId: string) => adminListUserDelegations(db, mgr.getApiBaseUrl(), userId));
  ipcMain.handle(
    'admin:users:delegationCreate',
    async (_e, args: { fromUserId: string; toUserId: string; permCode: string; startsAt?: number; endsAt: number; note?: string }) =>
      adminCreateDelegation(db, mgr.getApiBaseUrl(), args),
  );
  ipcMain.handle('admin:users:delegationRevoke', async (_e, args: { id: string; note?: string }) =>
    adminRevokeDelegation(db, mgr.getApiBaseUrl(), args.id, args.note),
  );

  ipcMain.handle('update:check', async () => checkForUpdates());

  // -----------------------------
  // Files
  // -----------------------------
  ipcMain.handle('files:upload', async (_e, args: { path: string }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'files.upload')) return { ok: false, error: 'permission denied: files.upload' };
    return filesUpload(db, mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('files:pick', async () => {
    try {
      const perms = await currentPermissions();
      if (!hasPerm(perms, 'files.upload')) return { ok: false, error: 'permission denied: files.upload' };
      const r = await dialog.showOpenDialog({
        title: 'Выберите файлы для загрузки',
        properties: ['openFile', 'multiSelections'],
      });
      const paths = (r.filePaths ?? []).map((p) => String(p)).filter(Boolean);
      if (paths.length === 0) return { ok: false, error: 'cancelled' };
      return { ok: true, paths };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('files:downloadDir:get', async () => {
    return filesDownloadDirGet(db, { defaultDir: app.getPath('downloads') });
  });

  ipcMain.handle('files:downloadDir:pick', async () => {
    try {
      const perms = await currentPermissions();
      if (!hasPerm(perms, 'files.view')) return { ok: false, error: 'permission denied: files.view' };
      const r = await dialog.showOpenDialog({
        title: 'Выберите папку для скачивания файлов',
        properties: ['openDirectory', 'createDirectory'],
      });
      const p = r.filePaths?.[0] ? String(r.filePaths[0]) : '';
      if (!p) return { ok: false, error: 'cancelled' };
      return await filesDownloadDirSet(db, p);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('files:download', async (_e, args: { fileId: string }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'files.view')) return { ok: false, error: 'permission denied: files.view' };
    const dir = await filesDownloadDirGet(db, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return filesDownload(db, mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path });
  });

  ipcMain.handle('files:open', async (_e, args: { fileId: string }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'files.view')) return { ok: false, error: 'permission denied: files.view' };
    const dir = await filesDownloadDirGet(db, { defaultDir: app.getPath('downloads') });
    if (!dir.ok) return dir;
    return filesOpen(db, mgr.getApiBaseUrl(), { fileId: args.fileId, downloadDir: dir.path });
  });

  ipcMain.handle('files:delete', async (_e, args: { fileId: string }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'files.delete')) return { ok: false, error: 'permission denied: files.delete' };
    return filesDelete(db, mgr.getApiBaseUrl(), { fileId: args.fileId });
  });

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
      args: { engineId: string; stage: string; templateId: string; operationId?: string | null; answers: any; attachments?: any[] },
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
        attachments: Array.isArray(args.attachments) ? args.attachments : undefined,
      };

      return saveRepairChecklistForEngine(db, { engineId: args.engineId, stage: args.stage, operationId: args.operationId, payload, actor });
    },
  );

  // -----------------------------
  // Supply requests (Заявки)
  // -----------------------------
  ipcMain.handle('supplyRequests:list', async (_e, args?: { q?: string; month?: string }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'supply_requests.view')) return { ok: false, error: 'permission denied: supply_requests.view' };
    return listSupplyRequests(db, args);
  });

  ipcMain.handle('supplyRequests:get', async (_e, id: string) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'supply_requests.view')) return { ok: false, error: 'permission denied: supply_requests.view' };
    return getSupplyRequest(db, id);
  });

  ipcMain.handle('supplyRequests:create', async () => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'supply_requests.create')) return { ok: false, error: 'permission denied: supply_requests.create' };
    return createSupplyRequest(db, await currentActor());
  });

  ipcMain.handle('supplyRequests:update', async (_e, args: { id: string; payload: any }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'supply_requests.edit')) return { ok: false, error: 'permission denied: supply_requests.edit' };
    const actor = await currentActor();
    return updateSupplyRequest(db, { id: args.id, payload: args.payload, actor });
  });

  ipcMain.handle('supplyRequests:transition', async (_e, args: { id: string; action: string; note?: string | null }) => {
    const perms = await currentPermissions();

    const action = String(args.action);
    const required =
      action === 'sign'
        ? 'supply_requests.sign'
        : action === 'director_approve'
          ? 'supply_requests.director_approve'
          : action === 'accept'
            ? 'supply_requests.accept'
            : action === 'fulfill_full' || action === 'fulfill_partial'
              ? 'supply_requests.fulfill'
              : null;

    if (!required) return { ok: false, error: `unknown action: ${action}` };
    if (!hasPerm(perms, required)) return { ok: false, error: `permission denied: ${required}` };

    const actor = await currentActor();
    return transitionSupplyRequest(db, { id: args.id, action: action as any, actor, note: args.note ?? null });
  });

  // Parts (Детали)
  // -----------------------------
  ipcMain.handle('parts:list', async (_e, args?: { q?: string; limit?: number }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'parts.view')) return { ok: false, error: 'permission denied: parts.view' };
    return partsList(db, mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:get', async (_e, partId: string) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'parts.view')) return { ok: false, error: 'permission denied: parts.view' };
    return partsGet(db, mgr.getApiBaseUrl(), { partId });
  });

  ipcMain.handle('parts:create', async (_e, args?: { attributes?: Record<string, unknown> }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'parts.create')) return { ok: false, error: 'permission denied: parts.create' };
    return partsCreate(db, mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:updateAttribute', async (_e, args: { partId: string; attributeCode: string; value: unknown }) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'parts.edit')) return { ok: false, error: 'permission denied: parts.edit' };
    return partsUpdateAttribute(db, mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('parts:delete', async (_e, partId: string) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'parts.delete')) return { ok: false, error: 'permission denied: parts.delete' };
    return partsDelete(db, mgr.getApiBaseUrl(), { partId });
  });

  ipcMain.handle('parts:getFiles', async (_e, partId: string) => {
    const perms = await currentPermissions();
    if (!hasPerm(perms, 'parts.view')) return { ok: false, error: 'permission denied: parts.view' };
    return partsGetFiles(db, mgr.getApiBaseUrl(), { partId });
  });
}


