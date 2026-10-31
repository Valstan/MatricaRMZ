import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, requirePermOrThrow, viewModeWriteError } from '../ipcContext.js';

import {
  createEngine,
  getEngineDetails,
  setEngineAttribute,
  advanceEngineStatusForWorkOrder,
  findEngineDuplicateCandidates,
  findEngineInternalNumberDuplicate,
  listReclamationDefectNatures,
  type AssemblyEngineStatusTarget,
} from '../../services/engineService.js';
import {
  acquireEngineReservation,
  getEngineReservation,
  releaseEngineReservation,
} from '../../services/engineReservationClient.js';
import { listEngineRmzNumbers } from '../../services/engineRmzNumbersHistory.js';
import { engineDedupeAnalyze, engineDedupeMerge } from '../../services/erpService.js';
import { logPerfWarn } from '../../services/logService.js';
import { getOperation, isManualHistoryRow, listOperations, addOperation, softDeleteOperation, updateManualEntry } from '../../services/operationService.js';
import { addAudit, listAudit } from '../../services/auditService.js';
import { softDeleteEntity } from '../../services/entityService.js';

export function registerEnginesOpsAuditIpc(ctx: IpcContext) {
  // Engines (read)
  ipcMain.handle('engine:list', async () => {
    await requirePermOrThrow(ctx, 'engines.view');
    // Список собирает отдельный процесс чтения (`workers/dataWorker.ts`): сборка держит
    // главный поток секундами на слабых машинах, а окно в это время стоит. В режиме
    // просмотра копии базы собираем здесь: воркер держит соединение с живой базой.
    const outcome = isViewMode(ctx) ? await ctx.engineList.readHere() : await ctx.engineList.read();
    const { rows, phases, ms } = outcome;
    if (ms >= 1500) {
      logPerfWarn(ctx.sysDb, ctx.mgr.getApiBaseUrl(), 'engine:list', `slow engine:list: ${ms}ms`, {
        action: 'engine:list',
        ms,
        rows: Array.isArray(rows) ? rows.length : -1,
        phases,
        // Откуда собрано: без этого флага журнал не отличит переехавшее чтение от отката.
        worker: ctx.engineList.outOfProcess,
      });
    }
    return rows;
  });
  ipcMain.handle('engine:get', async (_e, id: string) => {
    await requirePermOrThrow(ctx, 'engines.view');
    return getEngineDetails(ctx.dataDb(), id);
  });
  // Реестр номеров РМЗ с историей создания и удаления — экран «Номера РМЗ». Право то же,
  // что у списка двигателей: это тот же производственный контур, только со стороны номера.
  ipcMain.handle('engine:rmzNumbers', async () => {
    await requirePermOrThrow(ctx, 'engines.view');
    return listEngineRmzNumbers(ctx.dataDb());
  });
  ipcMain.handle('engine:reclamationNatures', async () => {
    await requirePermOrThrow(ctx, 'engines.view');
    return listReclamationDefectNatures(ctx.dataDb());
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

  // Advisory-резерв двигателя (Ф2). Резерв server-managed: `byAdmin` определяет
  // СЕРВЕР по роли сессии — клиент его не шлёт и подменить не может.
  ipcMain.handle('engine:reservation:get', async (_e, engineId: string) => {
    await requirePermOrThrow(ctx, 'engines.view');
    return getEngineReservation(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(engineId ?? ''));
  });
  ipcMain.handle('engine:reservation:acquire', async (_e, engineId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate;
    return acquireEngineReservation(ctx.sysDb, ctx.dataDb(), ctx.mgr.getApiBaseUrl(), String(engineId ?? ''));
  });
  ipcMain.handle('engine:reservation:release', async (_e, engineId: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate;
    return releaseEngineReservation(ctx.sysDb, ctx.dataDb(), ctx.mgr.getApiBaseUrl(), String(engineId ?? ''));
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
  ipcMain.handle('engine:delete', async (_e, engineId: string, reasonRaw?: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'engines.edit');
    if (!gate.ok) return gate;
    // Причина обязательна: номер РМЗ живёт в реестре навсегда, и «почему карточки нет»
    // — единственное, что объясняет дырку в нумерации через год. Без неё не удаляем.
    const reason = String(reasonRaw ?? '').trim();
    if (!reason) return { ok: false as const, error: 'Причина удаления обязательна' };
    const actor = await ctx.currentActor();
    // Причина пишется ДО удаления: сервер отбивает удаление двигателя, к которому нет
    // записи `engine.delete` с непустой причиной (гейт `engine_delete_reason_required`).
    // Обратный порядок оставлял бы окно, где карточка уже удалена, а причина не
    // записалась, — и тогда причина терялась бы навсегда, как это случилось 28.10
    // с шестью карточками, удалёнными с клиента 3.90.0.
    const audit = await addAudit(ctx.dataDb(), {
      actor,
      action: 'engine.delete',
      entityId: engineId,
      tableName: 'entities',
      payload: { reason },
    });
    if (!audit.ok) return { ok: false as const, error: `Причина не записалась, карточка не удалена: ${audit.error}` };
    const deleted = await softDeleteEntity(ctx.dataDb(), engineId);
    if (!deleted.ok) return deleted;
    return deleted;
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
  ipcMain.handle('ops:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    await requirePermOrThrow(ctx, 'operations.edit');
    // Удаляем только ручную запись: этап снимается через stages:remove (своя логика),
    // строку работ — на её экране. Общий канал чужое не трогает.
    const row = await getOperation(ctx.dataDb(), id);
    if (!row || row.deletedAt || !isManualHistoryRow(row)) {
      return { ok: false as const, error: 'Удалять можно только ручную запись' };
    }
    const ok = await softDeleteOperation(ctx.dataDb(), id);
    return ok ? { ok: true as const } : { ok: false as const, error: 'Запись не найдена' };
  });
  ipcMain.handle('ops:updateManual', async (_e, _engineId: string, id: string, patch: { action?: string; at?: number; note?: string; workshopId?: string; workshopName?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    await requirePermOrThrow(ctx, 'operations.edit');
    const ok = await updateManualEntry(ctx.dataDb(), id, patch);
    return ok ? { ok: true as const } : { ok: false as const, error: 'Запись не найдена' };
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


