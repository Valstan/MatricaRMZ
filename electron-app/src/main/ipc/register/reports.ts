import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';

import { buildPeriodStagesCsv, buildPeriodStagesCsvByLink } from '../../services/reportService.js';

export function registerReportsIpc(ctx: IpcContext) {
  ipcMain.handle('reports:periodStagesCsv', async (_e, args: { startMs?: number; endMs: number }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return buildPeriodStagesCsv(ctx.dataDb(), args);
  });

  ipcMain.handle('reports:periodStagesByLinkCsv', async (_e, args: { startMs?: number; endMs: number; linkAttrCode: string }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return buildPeriodStagesCsvByLink(ctx.dataDb(), args);
  });
}


