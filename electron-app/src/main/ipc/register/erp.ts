import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult } from '../ipcContext.js';
import {
  erpCardsList,
  erpCardsUpsert,
  erpDictionaryList,
  erpDictionaryUpsert,
  erpDocumentsCreate,
  erpDocumentsList,
  erpDocumentsPost,
  warehouseEngineInstanceDelete,
  warehouseEngineInstancesList,
  warehouseEngineInstanceUpsert,
  warehouseDocumentCreate,
  warehouseDocumentCancel,
  warehouseDocumentGet,
  warehouseDocumentPlan,
  warehouseLookupsGet,
  warehouseAssemblyBomActivateDefault,
  warehouseAssemblyBomArchive,
  warehouseAssemblyBomDelete,
  warehouseAssemblyBomGet,
  warehouseAssemblyBomSchemaGet,
  warehouseAssemblyBomSchemaUsageGet,
  warehouseAssemblyBomSchemaSet,
  warehouseAssemblyBomHistory,
  warehouseAssemblyBomList,
  warehouseAssemblyBomPrint,
  warehouseAssemblyBomUpsert,
  warehouseDocumentPost,
  warehouseDocumentsList,
  warehouseForecastBomGet,
  warehouseForecastIncomingGet,
  warehouseMovementsList,
  warehouseNomenclatureDelete,
  warehouseNomenclatureEngineBrandDelete,
  warehouseNomenclatureEngineBrandsList,
  warehouseNomenclatureEngineBrandUpsert,
  warehouseNomenclatureList,
  warehouseNomenclatureUpsert,
  warehouseStockList,
} from '../../services/erpService.js';

export function registerErpIpc(ctx: IpcContext) {
  ipcMain.handle('erp:dictionary:list', async (_e, moduleName: 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees') => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp dictionary is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return erpDictionaryList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), moduleName);
  });

  ipcMain.handle(
    'erp:dictionary:upsert',
    async (
      _e,
      args: {
        moduleName: 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees';
        id?: string;
        code: string;
        name: string;
        payloadJson?: string | null;
      },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp dictionary is not available' };
      const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
      if (!gate.ok) return gate as any;
      return erpDictionaryUpsert(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('erp:cards:list', async (_e, moduleName: 'parts' | 'tools' | 'employees') => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp cards are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.cards.view');
    if (!gate.ok) return gate as any;
    return erpCardsList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), moduleName);
  });

  ipcMain.handle(
    'erp:cards:upsert',
    async (
      _e,
      args: {
        moduleName: 'parts' | 'tools' | 'employees';
        id?: string;
        templateId?: string | null;
        serialNo?: string | null;
        cardNo?: string | null;
        status?: string | null;
        payloadJson?: string | null;
        fullName?: string | null;
        personnelNo?: string | null;
        roleCode?: string | null;
      },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp cards are not available' };
      const gate = await requirePermOrResult(ctx, 'erp.cards.edit');
      if (!gate.ok) return gate as any;
      return erpCardsUpsert(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('erp:documents:list', async (_e, args?: { status?: string; docType?: string }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp documents are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.documents.view');
    if (!gate.ok) return gate as any;
    return erpDocumentsList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle(
    'erp:documents:create',
    async (
      _e,
      args: {
        docType: string;
        docNo: string;
        docDate?: number;
        departmentId?: string | null;
        authorId?: string | null;
        payloadJson?: string | null;
        lines: Array<{ partCardId?: string | null; qty: number; price?: number | null; payloadJson?: string | null }>;
      },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp documents are not available' };
      const gate = await requirePermOrResult(ctx, 'erp.documents.edit');
      if (!gate.ok) return gate as any;
      return erpDocumentsCreate(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('erp:documents:post', async (_e, documentId: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: erp documents are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.documents.post');
    if (!gate.ok) return gate as any;
    return erpDocumentsPost(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(documentId || ''));
  });

  ipcMain.handle(
    'warehouse:nomenclature:list',
    async (_e, args?: { search?: string; itemType?: string; directoryKind?: string; groupId?: string; isActive?: boolean }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse nomenclature is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return warehouseNomenclatureList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('warehouse:lookups:get', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse lookups are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return warehouseLookupsGet(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('warehouse:nomenclature:upsert', async (_e, args: Record<string, unknown>) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse nomenclature is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseNomenclatureUpsert(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('warehouse:nomenclature:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse nomenclature is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseNomenclatureDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle('warehouse:nomenclature:engineBrands:list', async (_e, args: { nomenclatureId: string }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse nomenclature is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return warehouseNomenclatureEngineBrandsList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(args?.nomenclatureId || ''));
  });

  ipcMain.handle('warehouse:nomenclature:engineBrands:upsert', async (_e, args: Record<string, unknown>) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse nomenclature is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseNomenclatureEngineBrandUpsert(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('warehouse:nomenclature:engineBrands:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse nomenclature is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseNomenclatureEngineBrandDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle(
    'warehouse:stock:list',
    async (_e, args?: { warehouseId?: string; nomenclatureId?: string; search?: string; lowStockOnly?: boolean; limit?: number; offset?: number }) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse stock is not available' };
      const gate = await requirePermOrResult(ctx, 'erp.registers.view');
      if (!gate.ok) return gate as any;
      return warehouseStockList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle(
    'warehouse:documents:list',
    async (
      _e,
      args?: { status?: string; docType?: string; fromDate?: number; toDate?: number; search?: string; warehouseId?: string; limit?: number; offset?: number },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse documents are not available' };
      const gate = await requirePermOrResult(ctx, 'erp.documents.view');
      if (!gate.ok) return gate as any;
      return warehouseDocumentsList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle(
    'warehouse:engineInstances:list',
    async (
      _e,
      args?: { nomenclatureId?: string; contractId?: string; warehouseId?: string; status?: string; search?: string; limit?: number; offset?: number },
    ) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse instances are not available' };
      const gate = await requirePermOrResult(ctx, 'erp.registers.view');
      if (!gate.ok) return gate as any;
      return warehouseEngineInstancesList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('warehouse:engineInstances:upsert', async (_e, args: Record<string, unknown>) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse instances are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseEngineInstanceUpsert(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('warehouse:engineInstances:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse instances are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseEngineInstanceDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle('warehouse:documents:get', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse documents are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.documents.view');
    if (!gate.ok) return gate as any;
    return warehouseDocumentGet(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle('warehouse:documents:create', async (_e, args: Record<string, unknown>) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse documents are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.documents.edit');
    if (!gate.ok) return gate as any;
    return warehouseDocumentCreate(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('warehouse:documents:post', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse documents are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.documents.post');
    if (!gate.ok) return gate as any;
    return warehouseDocumentPost(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle('warehouse:documents:plan', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse documents are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.documents.edit');
    if (!gate.ok) return gate as any;
    return warehouseDocumentPlan(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle('warehouse:documents:cancel', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse documents are not available' };
    const gate = await requirePermOrResult(ctx, 'erp.documents.edit');
    if (!gate.ok) return gate as any;
    return warehouseDocumentCancel(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle(
    'warehouse:movements:list',
    async (_e, args?: { nomenclatureId?: string; warehouseId?: string; documentHeaderId?: string; fromDate?: number; toDate?: number; limit?: number }) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse movements are not available' };
      const gate = await requirePermOrResult(ctx, 'erp.registers.view');
      if (!gate.ok) return gate as any;
      return warehouseMovementsList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );

  ipcMain.handle('warehouse:forecast:incoming:get', async (_e, args: { from: number; to: number; warehouseId?: string }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse forecast is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.registers.view');
    if (!gate.ok) return gate as any;
    return warehouseForecastIncomingGet(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('warehouse:assemblyBom:list', async (_e, args?: { engineNomenclatureId?: string; status?: string }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomList(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('warehouse:assemblyBom:schema:get', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomSchemaGet(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('warehouse:assemblyBom:schema:set', async (_e, args: { schema: unknown; renames?: Array<{ fromTypeId: string; toTypeId: string }> }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomSchemaSet(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('warehouse:assemblyBom:schema:usage:get', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomSchemaUsageGet(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('warehouse:assemblyBom:get', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomGet(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle('warehouse:assemblyBom:upsert', async (_e, args: Record<string, unknown>) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomUpsert(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
  });

  ipcMain.handle('warehouse:assemblyBom:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomDelete(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle('warehouse:assemblyBom:activateDefault', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomActivateDefault(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle('warehouse:assemblyBom:archive', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomArchive(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle('warehouse:assemblyBom:history', async (_e, args: { engineNomenclatureId: string }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomHistory(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(args?.engineNomenclatureId || ''));
  });

  ipcMain.handle('warehouse:assemblyBom:print', async (_e, id: string) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse BOM is not available' };
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as any;
    return warehouseAssemblyBomPrint(ctx.sysDb, ctx.mgr.getApiBaseUrl(), String(id || ''));
  });

  ipcMain.handle(
    'warehouse:forecast:bom:get',
    async (_e, args: { engineId: string; targetEnginesPerDay?: number; horizonDays?: number; warehouseIds?: string[] }) => {
      if (isViewMode(ctx)) return { ok: false as const, error: 'view mode: warehouse forecast is not available' };
      const gate = await requirePermOrResult(ctx, 'erp.registers.view');
      if (!gate.ok) return gate as any;
      return warehouseForecastBomGet(ctx.sysDb, ctx.mgr.getApiBaseUrl(), args);
    },
  );
}
