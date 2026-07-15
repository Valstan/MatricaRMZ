import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, requirePermOrThrow, viewModeWriteError } from '../ipcContext.js';

import {
  listEngines,
  createEngine,
  getEngineDetails,
  setEngineAttribute,
  advanceEngineStatusForWorkOrder,
  findEngineDuplicateCandidates,
  findEngineInternalNumberDuplicate,
  type AssemblyEngineStatusTarget,
} from '../../services/engineService.js';
import { engineDedupeAnalyze, engineDedupeMerge } from '../../services/erpService.js';
import { listOperations, addOperation } from '../../services/operationService.js';
import { addAudit, listAudit } from '../../services/auditService.js';
import { softDeleteEntity } from '../../services/entityService.js';

export function registerEnginesOpsAuditIpc(ctx: IpcContext) {
  // Engines (read)
  ipcMain.handle('engine:list', async () => {
    await requirePermOrThrow(ctx, 'engines.view');
    return listEngines(ctx.dataDb());
  });
  ipcMain.handle('engine:get', async (_e, id: string) => {
    await requirePermOrThrow(ctx, 'engines.view');
    return getEngineDetails(ctx.dataDb(), id);
  });
  ipcMain.handle('engine:findDuplicateCandidates', async (_e, args: { engineNumber: string; excludeEngineId?: string }) => {
    await requirePermOrThrow(ctx, 'engines.view');
    return findEngineDuplicateCandidates(ctx.dataDb(), args?.engineNumber ?? '', args?.excludeEngineId);
  });
  ipcMain.handle(
    'engine:findInternalNumberDuplicate',
    async (_e, args: { internalNumber: string; internalNumberYear: number; excludeEngineId?: string }) => {
      await requirePermOrThrow(ctx, 'engines.view');
      return findEngineInternalNumberDuplicate(
        ctx.dataDb(),
        args?.internalNumber ?? '',
        args?.internalNumberYear,
        args?.excludeEngineId,
      );
    },
  );
  // Bulk duplicate analysis + operator merge (full server scan — authoritative, not the
  // possibly-partial local cache).
  ipcMain.handle('engine:dedupe:analyze', async () => {
    await requirePermOrThrow(ctx, 'engines.view');
    return engineDedupeAnalyze(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });
  ipcMain.handle('engine:dedupe:merge', async (_e, args: { survivorId: string; loserIds: string[] }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate;
    return engineDedupeMerge(ctx.sysDb, ctx.mgr.getApiBaseUrl(), {
      survivorId: String(args?.survivorId ?? ''),
      loserIds: Array.isArray(args?.loserIds) ? args.loserIds.map(String) : [],
    });
  });

  // Engines (write)
  ipcMain.handle('engine:create', async () => {
    if (isViewMode(ctx)) return viewModeWriteError();
    await requirePermOrThrow(ctx, 'engines.edit');
    return createEngine(ctx.dataDb(), await ctx.currentActor());
  });
  ipcMain.handle('engine:setAttr', async (_e, engineId: string, code: string, value: unknown) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    await requirePermOrThrow(ctx, 'engines.edit');
    return setEngineAttribute(ctx.dataDb(), engineId, code, value, await ctx.currentActor());
  });
  // Ф2: авто-переход статуса двигателя из сборочного наряда («Выдать в работу» → «Начат
  // ремонт»; дата выполнения → «Отремонтирован»). Guard «только вперёд» — внутри сервиса.
  ipcMain.handle(
    'engine:advanceStatus',
    async (_e, args: { engineId: string; target: AssemblyEngineStatusTarget; dateMs: number }) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      await requirePermOrThrow(ctx, 'engines.edit');
      return advanceEngineStatusForWorkOrder(
        ctx.dataDb(),
        String(args?.engineId ?? ''),
        args?.target,
        Number(args?.dateMs),
        await ctx.currentActor(),
      );
    },
  );
  ipcMain.handle('engine:delete', async (_e, engineId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate;
    return softDeleteEntity(ctx.dataDb(), engineId);
  });

  // Operations
  ipcMain.handle('ops:list', async (_e, engineId: string) => {
    await requirePermOrThrow(ctx, 'operations.view');
    return listOperations(ctx.dataDb(), engineId);
  });
  ipcMain.handle('ops:add', async (_e, engineId: string, operationType: string, status: string, note?: string, metaJson?: string | null) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    await requirePermOrThrow(ctx, 'operations.edit');
    return addOperation(ctx.dataDb(), engineId, operationType, status, note, await ctx.currentActor(), metaJson);
  });

  // Audit
  ipcMain.handle('audit:list', async () => {
    // Audit is currently used mainly for troubleshooting/admin; keep as-is.
    return listAudit(ctx.dataDb());
  });

  ipcMain.handle('audit:add', async (_e, args: { action: string; entityId?: string | null; tableName?: string | null; payload?: unknown }) => {
    try {
      if (isViewMode(ctx)) return viewModeWriteError();
      const actor = await ctx.currentActor();
      return await addAudit(ctx.dataDb(), { actor, ...args });
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}


