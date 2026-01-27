import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';

import { buildPeriodStagesCsv, buildPeriodStagesCsvByLink } from '../../services/reportService.js';
import {
  reportsBuilderExport,
  reportsBuilderExportPdf,
  reportsBuilderMeta,
  reportsBuilderPreview,
  reportsBuilderPrint,
} from '../../services/reportsBuilderService.js';

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

  ipcMain.handle('reportsBuilder:meta', async () => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return reportsBuilderMeta(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('reportsBuilder:preview', async (_e, args) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return reportsBuilderPreview(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('reportsBuilder:export', async (_e, args) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return reportsBuilderExport(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('reportsBuilder:exportPdf', async (_e, args) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return reportsBuilderExportPdf(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('reportsBuilder:print', async (_e, args) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return reportsBuilderPrint(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });
}


