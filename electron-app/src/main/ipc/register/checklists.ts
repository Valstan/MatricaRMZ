import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';

import { getRepairChecklistForEngine, listRepairChecklistTemplates, saveRepairChecklistForEngine } from '../../services/checklistService.js';

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
}


