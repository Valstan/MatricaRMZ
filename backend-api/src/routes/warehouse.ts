import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  cancelWarehouseDocument,
  createWarehouseDocument,
  deleteWarehouseEngineInstance,
  deleteWarehouseNomenclatureEngineBrand,
  deleteWarehouseNomenclature,
  getWarehouseDocument,
  listWarehouseForecastIncoming,
  listWarehouseLookups,
  listWarehouseDocuments,
  listWarehouseEngineInstances,
  listWarehouseMovements,
  listWarehouseNomenclatureEngineBrands,
  listWarehouseNomenclature,
  listWarehouseStock,
  postWarehouseDocument,
  planWarehouseDocument,
  upsertWarehouseEngineInstance,
  upsertWarehouseNomenclatureEngineBrand,
  upsertWarehouseNomenclature,
} from '../services/warehouseService.js';
import {
  activateWarehouseAssemblyBomAsDefault,
  archiveWarehouseAssemblyBom,
  buildWarehouseBomExpandedForecast,
  getWarehouseAssemblyBom,
  getWarehouseAssemblyBomPrintPayload,
  getWarehouseAssemblyBomComponentTypeUsage,
  listWarehouseAssemblyBomHistory,
  listWarehouseAssemblyBoms,
  renameWarehouseBomComponentTypes,
  upsertWarehouseAssemblyBom,
} from '../services/warehouseBomService.js';
import { computeAssemblyForecastFromServer } from '../services/warehouseForecastService.js';
import { getGlobalWarehouseBomRelationSchema, setGlobalWarehouseBomRelationSchema } from '../services/clientSettingsService.js';

export const warehouseRouter = Router();
warehouseRouter.use(requireAuth);

warehouseRouter.get('/lookups', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  const result = await listWarehouseLookups();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/nomenclature', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    search: z.string().optional(),
    itemType: z.string().optional(),
    directoryKind: z.string().optional(),
    groupId: z.string().optional(),
    isActive: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(10_000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseNomenclature({
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
    ...(parsed.data.itemType !== undefined ? { itemType: parsed.data.itemType } : {}),
    ...(parsed.data.directoryKind !== undefined ? { directoryKind: parsed.data.directoryKind } : {}),
    ...(parsed.data.groupId !== undefined ? { groupId: parsed.data.groupId } : {}),
    ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/nomenclature', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    code: z.string().min(1),
    sku: z.string().nullable().optional(),
    name: z.string().min(1),
    itemType: z.string().optional(),
    category: z.string().nullable().optional(),
    directoryKind: z.string().nullable().optional(),
    directoryRefId: z.string().uuid().nullable().optional(),
    groupId: z.string().uuid().nullable().optional(),
    unitId: z.string().uuid().nullable().optional(),
    barcode: z.string().nullable().optional(),
    minStock: z.coerce.number().int().nullable().optional(),
    maxStock: z.coerce.number().int().nullable().optional(),
    defaultBrandId: z.string().uuid().nullable().optional(),
    isSerialTracked: z.boolean().optional(),
    defaultWarehouseId: z.string().nullable().optional(),
    specJson: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWarehouseNomenclature({
    code: parsed.data.code,
    ...(parsed.data.sku !== undefined ? { sku: parsed.data.sku } : {}),
    name: parsed.data.name,
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    ...(parsed.data.itemType !== undefined ? { itemType: parsed.data.itemType } : {}),
    ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
    ...(parsed.data.directoryKind !== undefined ? { directoryKind: parsed.data.directoryKind } : {}),
    ...(parsed.data.directoryRefId !== undefined ? { directoryRefId: parsed.data.directoryRefId } : {}),
    ...(parsed.data.groupId !== undefined ? { groupId: parsed.data.groupId } : {}),
    ...(parsed.data.unitId !== undefined ? { unitId: parsed.data.unitId } : {}),
    ...(parsed.data.barcode !== undefined ? { barcode: parsed.data.barcode } : {}),
    ...(parsed.data.minStock !== undefined ? { minStock: parsed.data.minStock } : {}),
    ...(parsed.data.maxStock !== undefined ? { maxStock: parsed.data.maxStock } : {}),
    ...(parsed.data.defaultBrandId !== undefined ? { defaultBrandId: parsed.data.defaultBrandId } : {}),
    ...(parsed.data.isSerialTracked !== undefined ? { isSerialTracked: parsed.data.isSerialTracked } : {}),
    ...(parsed.data.defaultWarehouseId !== undefined ? { defaultWarehouseId: parsed.data.defaultWarehouseId } : {}),
    ...(parsed.data.specJson !== undefined ? { specJson: parsed.data.specJson } : {}),
    ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.delete('/nomenclature/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await deleteWarehouseNomenclature({ id });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/nomenclature/:id/engine-brands', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const nomenclatureId = String(req.params.id || '').trim();
  if (!nomenclatureId) return res.status(400).json({ ok: false, error: 'nomenclatureId обязателен' });
  const result = await listWarehouseNomenclatureEngineBrands({ nomenclatureId });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/nomenclature/engine-brands', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    nomenclatureId: z.string().uuid(),
    engineBrandId: z.string().uuid(),
    isDefault: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWarehouseNomenclatureEngineBrand({
    nomenclatureId: parsed.data.nomenclatureId,
    engineBrandId: parsed.data.engineBrandId,
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    ...(parsed.data.isDefault !== undefined ? { isDefault: parsed.data.isDefault } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.delete('/nomenclature/engine-brands/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await deleteWarehouseNomenclatureEngineBrand({ id });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/stock', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const schema = z.object({
    warehouseId: z.string().optional(),
    nomenclatureId: z.string().uuid().optional(),
    search: z.string().optional(),
    lowStockOnly: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(10_000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseStock({
    ...(parsed.data.warehouseId !== undefined ? { warehouseId: parsed.data.warehouseId } : {}),
    ...(parsed.data.nomenclatureId !== undefined ? { nomenclatureId: parsed.data.nomenclatureId } : {}),
    ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
    ...(parsed.data.lowStockOnly !== undefined ? { lowStockOnly: parsed.data.lowStockOnly } : {}),
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/documents', requirePermission(PermissionCode.ErpDocumentsView), async (req, res) => {
  const schema = z.object({
    docType: z.string().optional(),
    status: z.string().optional(),
    fromDate: z.coerce.number().int().optional(),
    toDate: z.coerce.number().int().optional(),
    search: z.string().optional(),
    warehouseId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(10_000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseDocuments({
    ...(parsed.data.docType !== undefined ? { docType: parsed.data.docType } : {}),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.fromDate !== undefined ? { fromDate: parsed.data.fromDate } : {}),
    ...(parsed.data.toDate !== undefined ? { toDate: parsed.data.toDate } : {}),
    ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
    ...(parsed.data.warehouseId !== undefined ? { warehouseId: parsed.data.warehouseId } : {}),
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/engine-instances', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const schema = z.object({
    nomenclatureId: z.string().uuid().optional(),
    contractId: z.string().uuid().optional(),
    warehouseId: z.string().optional(),
    status: z.string().optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(10_000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseEngineInstances({
    ...(parsed.data.nomenclatureId !== undefined ? { nomenclatureId: parsed.data.nomenclatureId } : {}),
    ...(parsed.data.contractId !== undefined ? { contractId: parsed.data.contractId } : {}),
    ...(parsed.data.warehouseId !== undefined ? { warehouseId: parsed.data.warehouseId } : {}),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/engine-instances', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    nomenclatureId: z.string().uuid(),
    serialNumber: z.string().min(1),
    contractId: z.string().uuid().nullable().optional(),
    warehouseId: z.string().optional(),
    currentStatus: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWarehouseEngineInstance({
    nomenclatureId: parsed.data.nomenclatureId,
    serialNumber: parsed.data.serialNumber,
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    ...(parsed.data.contractId !== undefined ? { contractId: parsed.data.contractId } : {}),
    ...(parsed.data.warehouseId !== undefined ? { warehouseId: parsed.data.warehouseId } : {}),
    ...(parsed.data.currentStatus !== undefined ? { currentStatus: parsed.data.currentStatus } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.delete('/engine-instances/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await deleteWarehouseEngineInstance({ id });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/assembly-bom', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const schema = z.object({
    engineNomenclatureId: z.string().uuid().optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseAssemblyBoms({
    ...(parsed.data.engineNomenclatureId ? { engineNomenclatureId: parsed.data.engineNomenclatureId } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/assembly-bom/schema', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  try {
    const result = await getGlobalWarehouseBomRelationSchema();
    return res.json({ ok: true, schema: JSON.parse(result.schemaJson), updatedAt: result.updatedAt });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

warehouseRouter.post('/assembly-bom/schema', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    schema: z.unknown(),
    renames: z
      .array(
        z.object({
          fromTypeId: z.string().min(1),
          toTypeId: z.string().min(1),
        }),
      )
      .optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  try {
    const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
    let renamedLineCount = 0;
    if (parsed.data.renames && parsed.data.renames.length > 0) {
      const renameResult = await renameWarehouseBomComponentTypes({
        renames: parsed.data.renames,
        actor: {
          id: String(user?.id ?? ''),
          username: String(user?.username ?? 'unknown'),
          role: String(user?.role ?? 'user'),
        },
      });
      if (!renameResult.ok) return res.status(500).json(renameResult);
      renamedLineCount = renameResult.renamedLineCount;
    }
    const result = await setGlobalWarehouseBomRelationSchema({ schema: parsed.data.schema });
    return res.json({ ok: true, schema: JSON.parse(result.schemaJson), updatedAt: result.updatedAt, renamedLineCount });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

warehouseRouter.get('/assembly-bom/schema/usage', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  const result = await getWarehouseAssemblyBomComponentTypeUsage();
  if (!result.ok) return res.status(500).json(result);
  return res.json(result);
});

warehouseRouter.get('/assembly-bom/:id', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await getWarehouseAssemblyBom({ id });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/assembly-bom', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(1),
    engineNomenclatureId: z.string().uuid(),
    version: z.coerce.number().int().min(1).optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    isDefault: z.boolean().optional(),
    notes: z.string().nullable().optional(),
    lines: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          componentNomenclatureId: z.string().uuid(),
          componentType: z.enum(['sleeve', 'piston', 'ring', 'jacket', 'head', 'other']).optional(),
          qtyPerUnit: z.coerce.number().int().min(0),
          variantGroup: z.string().nullable().optional(),
          lineKey: z.string().nullable().optional(),
          parentLineKey: z.string().nullable().optional(),
          isRequired: z.boolean().optional(),
          priority: z.coerce.number().int().optional(),
          notes: z.string().nullable().optional(),
        }),
      )
      .default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await upsertWarehouseAssemblyBom({
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    name: parsed.data.name,
    engineNomenclatureId: parsed.data.engineNomenclatureId,
    ...(parsed.data.version !== undefined ? { version: parsed.data.version } : {}),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.isDefault !== undefined ? { isDefault: parsed.data.isDefault } : {}),
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    lines: parsed.data.lines.map((line) => ({
      ...(line.id ? { id: line.id } : {}),
      componentNomenclatureId: line.componentNomenclatureId,
      ...(line.componentType !== undefined ? { componentType: line.componentType } : {}),
      qtyPerUnit: line.qtyPerUnit,
      ...(line.variantGroup !== undefined ? { variantGroup: line.variantGroup } : {}),
      ...(line.lineKey !== undefined ? { lineKey: line.lineKey } : {}),
      ...(line.parentLineKey !== undefined ? { parentLineKey: line.parentLineKey } : {}),
      ...(line.isRequired !== undefined ? { isRequired: line.isRequired } : {}),
      ...(line.priority !== undefined ? { priority: line.priority } : {}),
      ...(line.notes !== undefined ? { notes: line.notes } : {}),
    })),
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/assembly-bom/:id/activate-default', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await activateWarehouseAssemblyBomAsDefault({
    id,
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/assembly-bom/:id/archive', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await archiveWarehouseAssemblyBom({
    id,
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/assembly-bom/:engineNomenclatureId/history', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const engineNomenclatureId = String(req.params.engineNomenclatureId || '').trim();
  if (!engineNomenclatureId) return res.status(400).json({ ok: false, error: 'engineNomenclatureId обязателен' });
  const result = await listWarehouseAssemblyBomHistory({ engineNomenclatureId });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/assembly-bom/:id/print', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await getWarehouseAssemblyBomPrintPayload({ id });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/documents/:id', requirePermission(PermissionCode.ErpDocumentsView), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await getWarehouseDocument({ id });
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

warehouseRouter.post('/documents', requirePermission(PermissionCode.ErpDocumentsEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    docType: z.string().min(1),
    status: z.enum(['draft', 'planned']).optional(),
    docNo: z.string().min(1),
    docDate: z.coerce.number().int().optional(),
    departmentId: z.string().nullable().optional(),
    authorId: z.string().uuid().nullable().optional(),
    header: z
      .object({
        warehouseId: z.string().nullable().optional(),
        expectedDate: z.coerce.number().int().nullable().optional(),
        sourceType: z.string().nullable().optional(),
        sourceRef: z.string().nullable().optional(),
        contractId: z.string().nullable().optional(),
        reason: z.string().nullable().optional(),
        counterpartyId: z.string().uuid().nullable().optional(),
      })
      .optional(),
    payloadJson: z.string().nullable().optional(),
    lines: z
      .array(
        z.object({
          qty: z.coerce.number().int(),
          price: z.coerce.number().int().nullable().optional(),
          cost: z.coerce.number().int().nullable().optional(),
          partCardId: z.string().uuid().nullable().optional(),
          nomenclatureId: z.string().uuid().nullable().optional(),
          unit: z.string().nullable().optional(),
          batch: z.string().nullable().optional(),
          note: z.string().nullable().optional(),
          warehouseId: z.string().nullable().optional(),
          fromWarehouseId: z.string().nullable().optional(),
          toWarehouseId: z.string().nullable().optional(),
          adjustmentQty: z.coerce.number().int().nullable().optional(),
          bookQty: z.coerce.number().int().nullable().optional(),
          actualQty: z.coerce.number().int().nullable().optional(),
          reason: z.string().nullable().optional(),
          payloadJson: z.string().nullable().optional(),
        }),
      )
      .default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await createWarehouseDocument({
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    docType: parsed.data.docType,
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    docNo: parsed.data.docNo,
    lines: parsed.data.lines.map((line) => ({
      qty: line.qty,
      ...(line.price !== undefined ? { price: line.price } : {}),
      ...(line.cost !== undefined ? { cost: line.cost } : {}),
      ...(line.partCardId !== undefined ? { partCardId: line.partCardId } : {}),
      ...(line.nomenclatureId !== undefined ? { nomenclatureId: line.nomenclatureId } : {}),
      ...(line.unit !== undefined ? { unit: line.unit } : {}),
      ...(line.batch !== undefined ? { batch: line.batch } : {}),
      ...(line.note !== undefined ? { note: line.note } : {}),
      ...(line.warehouseId !== undefined ? { warehouseId: line.warehouseId } : {}),
      ...(line.fromWarehouseId !== undefined ? { fromWarehouseId: line.fromWarehouseId } : {}),
      ...(line.toWarehouseId !== undefined ? { toWarehouseId: line.toWarehouseId } : {}),
      ...(line.adjustmentQty !== undefined ? { adjustmentQty: line.adjustmentQty } : {}),
      ...(line.bookQty !== undefined ? { bookQty: line.bookQty } : {}),
      ...(line.actualQty !== undefined ? { actualQty: line.actualQty } : {}),
      ...(line.reason !== undefined ? { reason: line.reason } : {}),
      ...(line.payloadJson !== undefined ? { payloadJson: line.payloadJson } : {}),
    })),
    ...(parsed.data.docDate !== undefined ? { docDate: parsed.data.docDate } : {}),
    ...(parsed.data.departmentId !== undefined ? { departmentId: parsed.data.departmentId } : {}),
    ...(parsed.data.authorId !== undefined ? { authorId: parsed.data.authorId } : {}),
    ...(parsed.data.header !== undefined
      ? {
          header: {
            ...(parsed.data.header.warehouseId !== undefined ? { warehouseId: parsed.data.header.warehouseId } : {}),
            ...(parsed.data.header.expectedDate !== undefined ? { expectedDate: parsed.data.header.expectedDate } : {}),
            ...(parsed.data.header.sourceType !== undefined ? { sourceType: parsed.data.header.sourceType } : {}),
            ...(parsed.data.header.sourceRef !== undefined ? { sourceRef: parsed.data.header.sourceRef } : {}),
            ...(parsed.data.header.contractId !== undefined ? { contractId: parsed.data.header.contractId } : {}),
            ...(parsed.data.header.reason !== undefined ? { reason: parsed.data.header.reason } : {}),
            ...(parsed.data.header.counterpartyId !== undefined ? { counterpartyId: parsed.data.header.counterpartyId } : {}),
          },
        }
      : {}),
    ...(parsed.data.payloadJson !== undefined ? { payloadJson: parsed.data.payloadJson } : {}),
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/documents/:id/plan', requirePermission(PermissionCode.ErpDocumentsEdit), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await planWarehouseDocument({
    documentId: id,
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/documents/:id/post', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await postWarehouseDocument({
    documentId: id,
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/documents/:id/cancel', requirePermission(PermissionCode.ErpDocumentsEdit), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await cancelWarehouseDocument({
    documentId: id,
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/movements', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const schema = z.object({
    nomenclatureId: z.string().uuid().optional(),
    warehouseId: z.string().optional(),
    documentHeaderId: z.string().uuid().optional(),
    fromDate: z.coerce.number().int().optional(),
    toDate: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseMovements({
    ...(parsed.data.nomenclatureId !== undefined ? { nomenclatureId: parsed.data.nomenclatureId } : {}),
    ...(parsed.data.warehouseId !== undefined ? { warehouseId: parsed.data.warehouseId } : {}),
    ...(parsed.data.documentHeaderId !== undefined ? { documentHeaderId: parsed.data.documentHeaderId } : {}),
    ...(parsed.data.fromDate !== undefined ? { fromDate: parsed.data.fromDate } : {}),
    ...(parsed.data.toDate !== undefined ? { toDate: parsed.data.toDate } : {}),
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/forecast/assembly-7d', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const schema = z.object({
    targetEnginesPerDay: z.coerce.number().int().min(0).max(500),
    horizonDays: z.coerce.number().int().min(1).max(31).optional(),
    warehouseIds: z.array(z.string().min(1)).optional(),
    engineNomenclatureIds: z.array(z.string().uuid()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  try {
    const forecast = await computeAssemblyForecastFromServer({
      targetEnginesPerDay: parsed.data.targetEnginesPerDay,
      ...(parsed.data.horizonDays !== undefined ? { horizonDays: parsed.data.horizonDays } : {}),
      ...(parsed.data.warehouseIds !== undefined ? { warehouseIds: parsed.data.warehouseIds } : {}),
      ...(parsed.data.engineNomenclatureIds !== undefined ? { engineNomenclatureIds: parsed.data.engineNomenclatureIds } : {}),
    });
    const statusRu = (s: string) => (s === 'ok' ? 'хватит' : s === 'shortage' ? 'не хватает' : 'ожидание');
    const rows = forecast.rows.map((r) => ({
      dayLabel: r.dayLabel,
      engineBrand: r.engineBrand,
      plannedEngines: r.plannedEngines,
      status: statusRu(r.status),
      requiredComponentsSummary: r.requiredComponentsSummary,
      deficitsSummary: r.deficitsSummary,
      alternativeBrands: r.alternativeBrands,
    }));
    return res.json({ ok: true, rows, warnings: forecast.warnings, deficitRecommendations: forecast.deficitRecommendations });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

warehouseRouter.get('/forecast/bom', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const schema = z.object({
    engineId: z.string().uuid(),
    targetEnginesPerDay: z.coerce.number().int().min(0).max(500).optional(),
    horizonDays: z.coerce.number().int().min(1).max(31).optional(),
    warehouseIds: z
      .union([z.array(z.string().min(1)), z.string().min(1)])
      .optional()
      .transform((value) => {
        if (!value) return undefined;
        if (Array.isArray(value)) return value;
        return value.split(',').map((item) => item.trim()).filter(Boolean);
      }),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await buildWarehouseBomExpandedForecast({
    engineId: parsed.data.engineId,
    ...(parsed.data.targetEnginesPerDay !== undefined ? { targetEnginesPerDay: parsed.data.targetEnginesPerDay } : {}),
    ...(parsed.data.horizonDays !== undefined ? { horizonDays: parsed.data.horizonDays } : {}),
    ...(parsed.data.warehouseIds !== undefined ? { warehouseIds: parsed.data.warehouseIds } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/forecast/incoming', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const schema = z.object({
    from: z.coerce.number().int(),
    to: z.coerce.number().int(),
    warehouseId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseForecastIncoming({
    from: parsed.data.from,
    to: parsed.data.to,
    ...(parsed.data.warehouseId ? { warehouseId: parsed.data.warehouseId } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
