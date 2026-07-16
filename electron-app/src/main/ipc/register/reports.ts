import { ipcMain } from 'electron';
import {
  CUSTOM_REPORT_TEMPLATES_LIMIT,
  REPORT_PRESET_DEFINITIONS,
  sanitizeCustomReportSpec,
  type CustomReportTemplate,
} from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { requirePermOrResult } from '../ipcContext.js';

import {
  buildReportByPreset,
  buildPeriodStagesCsv,
  buildPeriodStagesCsvByLink,
  buildDefectSupplyReport,
  exportReportPreset1cXml,
  exportReportPresetCsv,
  exportReportPresetPdf,
  exportDefectSupplyReportPdf,
  getReportPresetList,
  printDefectSupplyReport,
  printReportPreset,
} from '../../services/reportService.js';
import { SettingsKey, settingsGetString, settingsSetString } from '../../services/settingsStore.js';
import {
  exportCustomReportCsv,
  listCustomReportSources,
  printCustomReport,
  runCustomReport,
} from '../../services/customReportService.js';
import {
  reportsBuilderExport,
  reportsBuilderExportPdf,
  reportsBuilderMeta,
  reportsBuilderPreview,
  reportsBuilderPrint,
} from '../../services/reportsBuilderService.js';

const VALID_PRESET_IDS = new Set<string>(REPORT_PRESET_DEFINITIONS.map((preset) => String(preset.id)));
const REPORT_HISTORY_LIMIT = 50;
const REPORT_HISTORY_DEFAULT_LIMIT = 20;
const REPORT_USER_SCOPE_FALLBACK = '__global__';

type ReportHistoryEntry = {
  presetId: string;
  title: string;
  generatedAt: number;
};

function resolveUserScope(rawUserId: unknown): string {
  const userId = String(rawUserId ?? '').trim();
  return userId || REPORT_USER_SCOPE_FALLBACK;
}

function parseByScope<T>(raw: string | null): Record<string, T> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, T>;
  } catch {
    // ignore broken JSON
  }
  return {};
}

function sanitizePresetIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  for (const value of ids) {
    const id = String(value ?? '').trim();
    if (!id || !VALID_PRESET_IDS.has(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const FILTER_TEMPLATES_LIMIT = 20;

function sanitizeCustomReportTemplates(entries: unknown): CustomReportTemplate[] {
  if (!Array.isArray(entries)) return [];
  const out: CustomReportTemplate[] = [];
  for (const row of entries) {
    const id = String((row as any)?.id ?? '').trim();
    const name = String((row as any)?.name ?? '').trim();
    const spec = sanitizeCustomReportSpec((row as any)?.spec);
    if (!id || !name || !spec) continue;
    const createdAtRaw = Number((row as any)?.createdAt ?? 0);
    out.push({
      id,
      name,
      createdAt: Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : 0,
      spec,
    });
    if (out.length >= CUSTOM_REPORT_TEMPLATES_LIMIT) break;
  }
  return out;
}

type ReportFilterTemplate = {
  id: string;
  name: string;
  createdAt: number;
  filters: Record<string, unknown>;
  disabled: string[];
};

// Blob-структура: { [userScope]: { [presetId]: ReportFilterTemplate[] } }
function sanitizeFilterTemplates(entries: unknown): ReportFilterTemplate[] {
  if (!Array.isArray(entries)) return [];
  const out: ReportFilterTemplate[] = [];
  for (const row of entries) {
    const id = String((row as any)?.id ?? '').trim();
    const name = String((row as any)?.name ?? '').trim();
    if (!id || !name) continue;
    const createdAtRaw = Number((row as any)?.createdAt ?? 0);
    const filters = (row as any)?.filters;
    const disabledRaw = (row as any)?.disabled;
    out.push({
      id,
      name,
      createdAt: Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : 0,
      filters: filters && typeof filters === 'object' && !Array.isArray(filters) ? (filters as Record<string, unknown>) : {},
      disabled: Array.isArray(disabledRaw) ? disabledRaw.map((v: unknown) => String(v ?? '').trim()).filter(Boolean) : [],
    });
    if (out.length >= FILTER_TEMPLATES_LIMIT) break;
  }
  return out;
}

function sanitizeHistoryEntries(entries: unknown): ReportHistoryEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: ReportHistoryEntry[] = [];
  for (const row of entries) {
    const presetId = String((row as any)?.presetId ?? '').trim();
    if (!presetId || !VALID_PRESET_IDS.has(presetId)) continue;
    const generatedAtRaw = Number((row as any)?.generatedAt ?? 0);
    const generatedAt = Number.isFinite(generatedAtRaw) && generatedAtRaw > 0 ? Math.floor(generatedAtRaw) : 0;
    if (generatedAt <= 0) continue;
    const titleRaw = String((row as any)?.title ?? '').trim();
    const fallbackTitle = REPORT_PRESET_DEFINITIONS.find((preset) => String(preset.id) === presetId)?.title ?? presetId;
    out.push({
      presetId,
      title: titleRaw || fallbackTitle,
      generatedAt,
    });
  }
  out.sort((a, b) => b.generatedAt - a.generatedAt);
  const uniq: ReportHistoryEntry[] = [];
  const signatures = new Set<string>();
  for (const row of out) {
    const signature = `${row.presetId}::${row.generatedAt}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    uniq.push(row);
    if (uniq.length >= REPORT_HISTORY_LIMIT) break;
  }
  return uniq;
}

export function registerReportsIpc(ctx: IpcContext) {
  ipcMain.handle('reports:presetList', async () => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return getReportPresetList(ctx.dataDb(), { sysDb: ctx.sysDb, apiBaseUrl: ctx.mgr.getApiBaseUrl() });
  });

  ipcMain.handle('reports:presetPreview', async (_e, args) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return buildReportByPreset(ctx.dataDb(), args, { sysDb: ctx.sysDb, apiBaseUrl: ctx.mgr.getApiBaseUrl() });
  });

  ipcMain.handle('reports:presetPdf', async (_e, args) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return exportReportPresetPdf(ctx.dataDb(), args, { sysDb: ctx.sysDb, apiBaseUrl: ctx.mgr.getApiBaseUrl() });
  });

  ipcMain.handle('reports:presetCsv', async (_e, args) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return exportReportPresetCsv(ctx.dataDb(), args, { sysDb: ctx.sysDb, apiBaseUrl: ctx.mgr.getApiBaseUrl() });
  });

  ipcMain.handle('reports:preset1cXml', async (_e, args) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return exportReportPreset1cXml(ctx.dataDb(), args, { sysDb: ctx.sysDb, apiBaseUrl: ctx.mgr.getApiBaseUrl() });
  });

  ipcMain.handle('reports:presetPrint', async (_e, args) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return printReportPreset(ctx.dataDb(), args, { sysDb: ctx.sysDb, apiBaseUrl: ctx.mgr.getApiBaseUrl() });
  });

  ipcMain.handle('reports:favoritesGet', async (_e, args?: { userId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    const scope = resolveUserScope(args?.userId);
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.ReportPresetFavorites);
    const byScope = parseByScope<unknown>(raw);
    return { ok: true as const, ids: sanitizePresetIds(byScope[scope]) };
  });

  ipcMain.handle('reports:favoritesSet', async (_e, args?: { userId?: string; ids?: string[] }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    const scope = resolveUserScope(args?.userId);
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.ReportPresetFavorites);
    const byScope = parseByScope<unknown>(raw);
    const ids = sanitizePresetIds(args?.ids ?? []);
    byScope[scope] = ids;
    await settingsSetString(ctx.sysDb, SettingsKey.ReportPresetFavorites, JSON.stringify(byScope));
    return { ok: true as const, ids };
  });

  ipcMain.handle('reports:filterTemplatesList', async (_e, args?: { userId?: string; presetId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    const presetId = String(args?.presetId ?? '').trim();
    if (!presetId || !VALID_PRESET_IDS.has(presetId)) return { ok: false as const, error: 'Некорректный presetId' };
    const scope = resolveUserScope(args?.userId);
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.ReportPresetFilterTemplates);
    const byScope = parseByScope<Record<string, unknown>>(raw);
    return { ok: true as const, templates: sanitizeFilterTemplates(byScope[scope]?.[presetId]) };
  });

  ipcMain.handle(
    'reports:filterTemplateSave',
    async (
      _e,
      args?: {
        userId?: string;
        presetId?: string;
        template?: { id?: string; name?: string; filters?: Record<string, unknown>; disabled?: string[] };
      },
    ) => {
      const gate = await requirePermOrResult(ctx, 'reports.view');
      if (!gate.ok) return gate as any;
      const presetId = String(args?.presetId ?? '').trim();
      if (!presetId || !VALID_PRESET_IDS.has(presetId)) return { ok: false as const, error: 'Некорректный presetId' };
      const name = String(args?.template?.name ?? '').trim();
      if (!name) return { ok: false as const, error: 'Пустое имя шаблона' };
      const scope = resolveUserScope(args?.userId);
      const raw = await settingsGetString(ctx.sysDb, SettingsKey.ReportPresetFilterTemplates);
      const byScope = parseByScope<Record<string, unknown>>(raw);
      const current = sanitizeFilterTemplates(byScope[scope]?.[presetId]);
      const id = String(args?.template?.id ?? '').trim() || `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const entry = sanitizeFilterTemplates([
        { id, name, createdAt: Date.now(), filters: args?.template?.filters ?? {}, disabled: args?.template?.disabled ?? [] },
      ])[0];
      if (!entry) return { ok: false as const, error: 'Некорректный шаблон' };
      // Замена по id или по имени (пересохранение под тем же именем перезаписывает шаблон).
      const next = [entry, ...current.filter((t) => t.id !== entry.id && t.name !== entry.name)].slice(0, FILTER_TEMPLATES_LIMIT);
      byScope[scope] = { ...(byScope[scope] ?? {}), [presetId]: next };
      await settingsSetString(ctx.sysDb, SettingsKey.ReportPresetFilterTemplates, JSON.stringify(byScope));
      return { ok: true as const, templates: next };
    },
  );

  ipcMain.handle(
    'reports:filterTemplateDelete',
    async (_e, args?: { userId?: string; presetId?: string; templateId?: string }) => {
      const gate = await requirePermOrResult(ctx, 'reports.view');
      if (!gate.ok) return gate as any;
      const presetId = String(args?.presetId ?? '').trim();
      if (!presetId || !VALID_PRESET_IDS.has(presetId)) return { ok: false as const, error: 'Некорректный presetId' };
      const templateId = String(args?.templateId ?? '').trim();
      const scope = resolveUserScope(args?.userId);
      const raw = await settingsGetString(ctx.sysDb, SettingsKey.ReportPresetFilterTemplates);
      const byScope = parseByScope<Record<string, unknown>>(raw);
      const next = sanitizeFilterTemplates(byScope[scope]?.[presetId]).filter((t) => t.id !== templateId);
      byScope[scope] = { ...(byScope[scope] ?? {}), [presetId]: next };
      await settingsSetString(ctx.sysDb, SettingsKey.ReportPresetFilterTemplates, JSON.stringify(byScope));
      return { ok: true as const, templates: next };
    },
  );

  // «Мои отчёты»: конструктор поверх пресетов (источник → фильтры/колонки/сортировка → шаблон).
  ipcMain.handle('reports:customSources', async () => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return { ok: true as const, sources: listCustomReportSources() };
  });

  ipcMain.handle('reports:customRun', async (_e, args?: { spec?: unknown }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return runCustomReport(ctx.dataDb(), args?.spec, { sysDb: ctx.sysDb, apiBaseUrl: ctx.mgr.getApiBaseUrl() });
  });

  ipcMain.handle('reports:customPrint', async (_e, args?: { spec?: unknown }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return printCustomReport(ctx.dataDb(), args?.spec, { sysDb: ctx.sysDb, apiBaseUrl: ctx.mgr.getApiBaseUrl() });
  });

  ipcMain.handle('reports:customCsv', async (_e, args?: { spec?: unknown }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    return exportCustomReportCsv(ctx.dataDb(), args?.spec, { sysDb: ctx.sysDb, apiBaseUrl: ctx.mgr.getApiBaseUrl() });
  });

  ipcMain.handle('reports:customTemplatesList', async (_e, args?: { userId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    const scope = resolveUserScope(args?.userId);
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.CustomReportTemplates);
    const byScope = parseByScope<unknown>(raw);
    return { ok: true as const, templates: sanitizeCustomReportTemplates(byScope[scope]) };
  });

  ipcMain.handle(
    'reports:customTemplateSave',
    async (_e, args?: { userId?: string; template?: { id?: string; name?: string; spec?: unknown } }) => {
      const gate = await requirePermOrResult(ctx, 'reports.view');
      if (!gate.ok) return gate as any;
      const name = String(args?.template?.name ?? '').trim().slice(0, 200);
      if (!name) return { ok: false as const, error: 'Пустое имя шаблона' };
      const spec = sanitizeCustomReportSpec(args?.template?.spec);
      if (!spec) return { ok: false as const, error: 'Некорректная спецификация отчёта' };
      const scope = resolveUserScope(args?.userId);
      const raw = await settingsGetString(ctx.sysDb, SettingsKey.CustomReportTemplates);
      const byScope = parseByScope<unknown>(raw);
      const current = sanitizeCustomReportTemplates(byScope[scope]);
      const id = String(args?.template?.id ?? '').trim() || `crt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const entry: CustomReportTemplate = { id, name, createdAt: Date.now(), spec };
      // Замена по id или по имени (пересохранение под тем же именем перезаписывает шаблон).
      const next = [entry, ...current.filter((t) => t.id !== entry.id && t.name !== entry.name)].slice(
        0,
        CUSTOM_REPORT_TEMPLATES_LIMIT,
      );
      byScope[scope] = next;
      await settingsSetString(ctx.sysDb, SettingsKey.CustomReportTemplates, JSON.stringify(byScope));
      return { ok: true as const, templates: next, id };
    },
  );

  ipcMain.handle('reports:customTemplateDelete', async (_e, args?: { userId?: string; templateId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    const scope = resolveUserScope(args?.userId);
    const templateId = String(args?.templateId ?? '').trim();
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.CustomReportTemplates);
    const byScope = parseByScope<unknown>(raw);
    const next = sanitizeCustomReportTemplates(byScope[scope]).filter((t) => t.id !== templateId);
    byScope[scope] = next;
    await settingsSetString(ctx.sysDb, SettingsKey.CustomReportTemplates, JSON.stringify(byScope));
    return { ok: true as const, templates: next };
  });

  ipcMain.handle('reports:historyList', async (_e, args?: { userId?: string; limit?: number }) => {
    const gate = await requirePermOrResult(ctx, 'reports.view');
    if (!gate.ok) return gate as any;
    const scope = resolveUserScope(args?.userId);
    const limitRaw = Number(args?.limit ?? REPORT_HISTORY_DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(REPORT_HISTORY_LIMIT, Math.floor(limitRaw)))
      : REPORT_HISTORY_DEFAULT_LIMIT;
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.ReportPresetHistory);
    const byScope = parseByScope<unknown>(raw);
    const entries = sanitizeHistoryEntries(byScope[scope]).slice(0, limit);
    return { ok: true as const, entries };
  });

  ipcMain.handle(
    'reports:historyAdd',
    async (_e, args?: { userId?: string; entry?: { presetId?: string; title?: string; generatedAt?: number } }) => {
      const gate = await requirePermOrResult(ctx, 'reports.view');
      if (!gate.ok) return gate as any;
      const scope = resolveUserScope(args?.userId);
      const presetId = String(args?.entry?.presetId ?? '').trim();
      if (!presetId || !VALID_PRESET_IDS.has(presetId)) {
        return { ok: false as const, error: 'Некорректный presetId' };
      }
      const generatedAtRaw = Number(args?.entry?.generatedAt ?? Date.now());
      const generatedAt = Number.isFinite(generatedAtRaw) && generatedAtRaw > 0 ? Math.floor(generatedAtRaw) : Date.now();
      const fallbackTitle = REPORT_PRESET_DEFINITIONS.find((preset) => String(preset.id) === presetId)?.title ?? presetId;
      const title = String(args?.entry?.title ?? '').trim() || fallbackTitle;

      const raw = await settingsGetString(ctx.sysDb, SettingsKey.ReportPresetHistory);
      const byScope = parseByScope<unknown>(raw);
      const current = sanitizeHistoryEntries(byScope[scope]);
      const next = sanitizeHistoryEntries([{ presetId, title, generatedAt }, ...current]).slice(0, REPORT_HISTORY_LIMIT);
      byScope[scope] = next;
      await settingsSetString(ctx.sysDb, SettingsKey.ReportPresetHistory, JSON.stringify(byScope));
      return { ok: true as const };
    },
  );

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

  ipcMain.handle(
    'reports:defectSupplyPreview',
    async (
      _e,
      args: { startMs?: number; endMs: number; contractIds?: string[]; brandIds?: string[]; includePurchases?: boolean },
    ) => {
      const gate = await requirePermOrResult(ctx, 'reports.view');
      if (!gate.ok) return gate as any;
      return buildDefectSupplyReport(ctx.dataDb(), args);
    },
  );

  ipcMain.handle(
    'reports:defectSupplyPdf',
    async (
      _e,
      args: {
        startMs?: number;
        endMs: number;
        contractIds?: string[];
        contractLabels: string[];
        brandIds?: string[];
        includePurchases?: boolean;
      },
    ) => {
      const gate = await requirePermOrResult(ctx, 'reports.view');
      if (!gate.ok) return gate as any;
      return exportDefectSupplyReportPdf(ctx.dataDb(), args);
    },
  );

  ipcMain.handle(
    'reports:defectSupplyPrint',
    async (
      _e,
      args: {
        startMs?: number;
        endMs: number;
        contractIds?: string[];
        contractLabels: string[];
        brandIds?: string[];
        includePurchases?: boolean;
      },
    ) => {
      const gate = await requirePermOrResult(ctx, 'reports.view');
      if (!gate.ok) return gate as any;
      return printDefectSupplyReport(ctx.dataDb(), args);
    },
  );

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


