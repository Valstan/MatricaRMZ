import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';

import type { EngineActType } from '@matricarmz/shared';

import {
  getRepairChecklistForEngine,
  listEngineActVersions,
  listRepairChecklistTemplates,
  listRepairFundRequirementVersions,
  saveEngineActSnapshot,
  saveRepairChecklistForEngine,
  saveRepairFundRequirementSnapshot,
} from '../../services/checklistService.js';
import { listEnginePartStatusEvents } from '../../services/partStatusEventService.js';
import { listEngineStampedInstances } from '../../services/repairFundInstanceService.js';

export function registerChecklistsIpc(ctx: IpcContext) {
  ipcMain.handle('checklists:templates:list', async (_e, args?: { stage?: string }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as any;
    return listRepairChecklistTemplates(ctx.dataDb(), args?.stage);
  });

  ipcMain.handle('checklists:engine:get', async (_e, args: { engineId: string; stage: string }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as any;
    const t = await listRepairChecklistTemplates(ctx.dataDb(), args.stage);
    if (!t.ok) return t;
    const r = await getRepairChecklistForEngine(ctx.dataDb(), args.engineId, args.stage);
    if (!r.ok) return r;
    return { ok: true as const, operationId: r.operationId, payload: r.payload, templates: t.templates };
  });

  ipcMain.handle(
    'checklists:engine:save',
    async (
      _e,
      args: { engineId: string; stage: string; templateId: string; operationId?: string | null; answers: any; attachments?: any[] },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'operations.edit');
      if (!gate.ok) return gate as any;

      const t = await listRepairChecklistTemplates(ctx.dataDb(), args.stage);
      if (!t.ok) return t;
      const tmpl = t.templates.find((x) => x.id === args.templateId) ?? null;
      if (!tmpl) return { ok: false, error: 'template not found' };

      const actor = await ctx.currentActor();
      const payload = {
        kind: 'repair_checklist' as const,
        templateId: tmpl.id,
        templateVersion: tmpl.version,
        stage: args.stage,
        engineEntityId: args.engineId,
        filledBy: actor || null,
        filledAt: Date.now(),
        answers: args.answers ?? {},
        ...(Array.isArray(args.attachments) ? { attachments: args.attachments } : {}),
      };

      return saveRepairChecklistForEngine(ctx.dataDb(), {
        engineId: args.engineId,
        stage: args.stage,
        ...(args.operationId !== undefined ? { operationId: args.operationId } : {}),
        payload,
        actor,
      });
    },
  );

  // Ф5 (GAP-6): история статусов деталей двигателя (события part_status_event).
  ipcMain.handle('checklists:engine:partStatusEvents', async (_e, args: { engineId: string }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as any;
    return listEnginePartStatusEvents(ctx.dataDb(), args.engineId);
  });

  // Ремфонд Ф3: номерные экземпляры деталей двигателя (личные набитые номера).
  ipcMain.handle('checklists:engine:stampedInstances', async (_e, args: { engineId: string }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as any;
    return listEngineStampedInstances(ctx.dataDb(), args.engineId);
  });

  ipcMain.handle('checklists:engine:actVersions', async (_e, args: { engineId: string; actType: EngineActType }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as any;
    return listEngineActVersions(ctx.dataDb(), args.engineId, args.actType);
  });

  ipcMain.handle(
    'checklists:engine:actSnapshot',
    async (
      _e,
      args: {
        engineId: string;
        actType: EngineActType;
        rows: any[];
        header: { engineBrand: string; engineNumber: string; contractNumber: string };
        answers: any;
        selectedCount: number;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'operations.edit');
      if (!gate.ok) return gate as any;
      const actor = await ctx.currentActor();
      return saveEngineActSnapshot(ctx.dataDb(), {
        engineId: args.engineId,
        actType: args.actType,
        rows: args.rows ?? [],
        header: args.header,
        answers: args.answers ?? {},
        selectedCount: Number(args.selectedCount) || 0,
        actor,
      });
    },
  );

  // Ремфонд Ф4: версии печатного «требования к заказчику».
  ipcMain.handle('checklists:engine:requirementVersions', async (_e, args: { engineId: string }) => {
    const gate = await requirePermOrResult(ctx, 'operations.view');
    if (!gate.ok) return gate as any;
    return listRepairFundRequirementVersions(ctx.dataDb(), args.engineId);
  });

  ipcMain.handle(
    'checklists:engine:requirementSnapshot',
    async (
      _e,
      args: {
        engineId: string;
        instances: any[];
        header: { engineBrand: string; engineNumber: string; contractNumber: string };
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'operations.edit');
      if (!gate.ok) return gate as any;
      const actor = await ctx.currentActor();
      return saveRepairFundRequirementSnapshot(ctx.dataDb(), {
        engineId: args.engineId,
        instances: args.instances ?? [],
        header: args.header,
        actor,
      });
    },
  );
}


