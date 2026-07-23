import { Router } from 'express';
import { z } from 'zod';

import type { PartMetadata } from '@matricarmz/shared';
import { SYNTHETIC_NOMENCLATURE_CODE_REJECT, isSyntheticNomenclatureCode } from '@matricarmz/shared';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { intakeRepairFundFromEngine, intakeScrapFromEngine, previewRepairFundIntakeFromEngine, previewScrapIntakeFromEngine } from '../services/repairFundService.js';
import { captureStampedInstancesFromEngine, setStampedInstanceRepaired } from '../services/repairFundInstanceService.js';
import {
  cancelWarehouseDocument,
  createWarehouseDocument,
  deleteWarehouseEngineInstance,
  deleteWarehouseNomenclature,
  getWarehouseDocument,
  listWarehouseForecastIncoming,
  listWarehouseLookups,
  listWarehouseNomenclatureItemTypes,
  upsertWarehouseNomenclatureItemType,
  deleteWarehouseNomenclatureItemType,
  listWarehouseNomenclatureProperties,
  upsertWarehouseNomenclatureProperty,
  deleteWarehouseNomenclatureProperty,
  listWarehouseNomenclatureTemplates,
  upsertWarehouseNomenclatureTemplate,
  deleteWarehouseNomenclatureTemplate,
  listWarehouseDocuments,
  listWarehouseEngineInstances,
  listWarehouseMovements,
  getWarehouseNomenclaturePartSpec,
  upsertWarehouseNomenclaturePartSpec,
  listWarehouseNomenclaturePartSpecs,
  createDirectoryPart,
  listWarehouseNomenclature,
  listWarehouseNomenclatureGroupCounts,
  listWarehouseStock,
  postWarehouseDocument,
  planWarehouseDocument,
  reverseWarehouseDocument,
  upsertWarehouseEngineInstance,
  upsertWarehouseNomenclature,
} from '../services/warehouseService.js';
import {
  buildWarehouseBomExpandedForecast,
  getWarehouseAssemblyBom,
  getWarehouseAssemblyBomPrintPayload,
  getWarehouseAssemblyBomComponentTypeUsage,
  listWarehouseAssemblyBomHistory,
  listWarehouseAssemblyBoms,
  deleteWarehouseAssemblyBom,
  renameWarehouseBomComponentTypes,
  upsertWarehouseAssemblyBom,
} from '../services/warehouseBomService.js';
import { analyzeDirectoryPartDuplicates, mergeDirectoryParts } from '../services/directoryPartsDedupeService.js';
import { computeAssemblyForecastFromServer } from '../services/warehouseForecastService.js';
import { getGlobalWarehouseBomRelationSchema, setGlobalWarehouseBomRelationSchema } from '../services/clientSettingsService.js';
import { getIdempotentCommandResult, saveIdempotentCommandResult } from '../services/commandIdempotencyService.js';
import { getContractSections } from '../services/erpService.js';
import { getStockBalanceForWorkshop } from '../services/stockBalanceForWorkshopService.js';
import { getEngineOutputAnalytics } from '../services/analyticsService.js';

export const warehouseRouter = Router();
warehouseRouter.use(requireAuth);

// Аналитика выпуска двигателей по маркам (серии во времени). Read-only агрегация
// по EAV-жизненному-циклу двигателя — история уже есть, снапшоты не нужны.
warehouseRouter.get('/analytics/engine-output', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const schema = z.object({
    metric: z.enum(['shipped', 'repaired', 'arrived']).optional(),
    bucket: z.enum(['day', 'week', 'month']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    workshopId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await getEngineOutputAnalytics({
    ...(parsed.data.metric ? { metric: parsed.data.metric } : {}),
    ...(parsed.data.bucket ? { bucket: parsed.data.bucket } : {}),
    ...(parsed.data.from ? { from: parsed.data.from } : {}),
    ...(parsed.data.to ? { to: parsed.data.to } : {}),
    ...(parsed.data.workshopId ? { workshopId: parsed.data.workshopId } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Batch остатков для цеха (Workshop-наряд: live колонка «Остаток в цеху»).
// POST — список IDs может быть длинным, обходим URL-лимит. Permission PartsView
// семантически соответствует «оператор видит детали и их остатки».
warehouseRouter.post(
  '/stock-balances/by-workshop',
  requirePermission(PermissionCode.PartsView),
  async (req, res) => {
    const schema = z.object({
      workshopId: z.string().min(1),
      nomenclatureIds: z.array(z.string().min(1)),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const result = await getStockBalanceForWorkshop(parsed.data);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

warehouseRouter.get('/lookups', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  const result = await listWarehouseLookups();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/nomenclature/item-types', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  const result = await listWarehouseNomenclatureItemTypes();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/nomenclature/item-types', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    code: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWarehouseNomenclatureItemType({
    code: parsed.data.code,
    name: parsed.data.name,
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.delete('/nomenclature/item-types/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const result = await deleteWarehouseNomenclatureItemType({ id: String(req.params.id || '').trim() });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/nomenclature/properties', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  const result = await listWarehouseNomenclatureProperties();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/nomenclature/properties', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    code: z.string().min(1),
    name: z.string().min(1),
    dataType: z.string().min(1),
    isRequired: z.boolean().optional(),
    optionsJson: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWarehouseNomenclatureProperty({
    code: parsed.data.code,
    name: parsed.data.name,
    dataType: parsed.data.dataType,
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    ...(parsed.data.isRequired !== undefined ? { isRequired: parsed.data.isRequired } : {}),
    ...(parsed.data.optionsJson !== undefined ? { optionsJson: parsed.data.optionsJson } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.delete('/nomenclature/properties/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const result = await deleteWarehouseNomenclatureProperty({ id: String(req.params.id || '').trim() });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/nomenclature/templates', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  const result = await listWarehouseNomenclatureTemplates();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/nomenclature/templates', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    code: z.string().min(1),
    name: z.string().min(1),
    itemTypeCode: z.string().nullable().optional(),
    directoryKind: z.string().nullable().optional(),
    propertiesJson: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWarehouseNomenclatureTemplate({
    code: parsed.data.code,
    name: parsed.data.name,
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    ...(parsed.data.itemTypeCode !== undefined ? { itemTypeCode: parsed.data.itemTypeCode } : {}),
    ...(parsed.data.directoryKind !== undefined ? { directoryKind: parsed.data.directoryKind } : {}),
    ...(parsed.data.propertiesJson !== undefined ? { propertiesJson: parsed.data.propertiesJson } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.delete('/nomenclature/templates/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const result = await deleteWarehouseNomenclatureTemplate({ id: String(req.params.id || '').trim() });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/nomenclature/group-counts', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const schema = z.object({
    search: z.string().optional(),
    itemType: z.string().optional(),
    directoryKind: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseNomenclatureGroupCounts({
    ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
    ...(parsed.data.itemType !== undefined ? { itemType: parsed.data.itemType } : {}),
    ...(parsed.data.directoryKind !== undefined ? { directoryKind: parsed.data.directoryKind } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/nomenclature', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    search: z.string().optional(),
    itemType: z.string().optional(),
    directoryKind: z.string().optional(),
    directoryRefId: z.string().optional(),
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
    ...(parsed.data.directoryRefId !== undefined ? { directoryRefId: parsed.data.directoryRefId } : {}),
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
    // Конвенция «нет артикула = пустая строка» (её уже держат партиал-уникальные
    // индексы PG 0075 / клиент 0016). С min(1) карточку без артикула нельзя сохранить
    // вообще — 400 на каждой правке спецификации. Стоп-кран: заглушку не принимаем
    // ни от какого клиента — иначе синтетика набежит снова и Ф2 придётся гнать вечно.
    code: z.string().refine((v) => !isSyntheticNomenclatureCode(v), SYNTHETIC_NOMENCLATURE_CODE_REJECT),
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
    componentTypeId: z.string().nullable().optional(),
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
    ...(parsed.data.componentTypeId !== undefined ? { componentTypeId: parsed.data.componentTypeId } : {}),
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

warehouseRouter.get('/part-specs', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const engineBrandId = String(req.query.engineBrandId ?? '').trim();
  const result = await listWarehouseNomenclaturePartSpecs({
    ...(engineBrandId ? { engineBrandId } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Т2: duplicate-parts analysis + operator merge (docs/plans/parts-articul-acts-2026-06.md).
warehouseRouter.get('/parts-dedupe', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  const result = await analyzeDirectoryPartDuplicates();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/parts-dedupe/merge', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({ survivorId: z.string().min(1), mergedIds: z.array(z.string().min(1)).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await mergeDirectoryParts({
    survivorId: parsed.data.survivorId,
    mergedIds: parsed.data.mergedIds,
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/directory-parts', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    code: z
      .string()
      .nullable()
      .optional()
      .refine((v) => !isSyntheticNomenclatureCode(v), SYNTHETIC_NOMENCLATURE_CODE_REJECT),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await createDirectoryPart({
    name: parsed.data.name,
    ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/nomenclature/:id/part-spec', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const nomenclatureId = String(req.params.id || '').trim();
  if (!nomenclatureId) return res.status(400).json({ ok: false, error: 'nomenclatureId обязателен' });
  const result = await getWarehouseNomenclaturePartSpec({ nomenclatureId });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.put('/nomenclature/:id/part-spec', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const nomenclatureId = String(req.params.id || '').trim();
  if (!nomenclatureId) return res.status(400).json({ ok: false, error: 'nomenclatureId обязателен' });
  const fileRefSchema = z.object({}).passthrough();
  const metadataSchema = z
    .object({
      description: z.string().optional(),
      assemblyUnitNumber: z.string().optional(),
      engineNodeId: z.string().optional(),
      purchaseDate: z.number().optional(),
      supplierId: z.string().optional(),
      supplierLegacy: z.string().optional(),
      contractId: z.string().optional(),
      drawings: z.array(fileRefSchema).optional(),
      techDocs: z.array(fileRefSchema).optional(),
      attachments: z.array(fileRefSchema).optional(),
      statusFlags: z.record(z.boolean()).optional(),
      statusDates: z.record(z.number()).optional(),
      custom: z.record(z.unknown()).optional(),
      customDefs: z
        .array(z.object({ code: z.string(), name: z.string(), dataType: z.string(), sortOrder: z.number().optional() }))
        .optional(),
    })
    .optional();
  const schema = z.object({
    code: z
      .string()
      .nullable()
      .optional()
      .refine((v) => !isSyntheticNomenclatureCode(v), SYNTHETIC_NOMENCLATURE_CODE_REJECT),
    dimensions: z
      .array(z.object({ id: z.string(), name: z.string(), value: z.string() }))
      .optional(),
    brandLinks: z
      .array(
        z.object({
          id: z.string(),
          engineBrandId: z.string().nullable(),
          assemblyUnitNumber: z.string().nullable(),
          quantity: z.coerce.number(),
          // Т4: галочки актов на привязке деталь↔марка.
          inCompletenessAct: z.boolean().optional(),
          inDefectAct: z.boolean().optional(),
          // Живая привязка к группе марок (маркер источника связи; см. shared/liveGroupLinks).
          sourceGroupId: z.string().optional(),
        }),
      )
      .optional(),
    metadata: metadataSchema,
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWarehouseNomenclaturePartSpec({
    nomenclatureId,
    spec: {
      code: parsed.data.code ?? null,
      dimensions: parsed.data.dimensions ?? [],
      // exactOptionalPropertyTypes: zod-optional даёт boolean|undefined — undefined-ключи не передаём.
      brandLinks: (parsed.data.brandLinks ?? []).map((l) => ({
        id: l.id,
        engineBrandId: l.engineBrandId,
        assemblyUnitNumber: l.assemblyUnitNumber,
        quantity: l.quantity,
        ...(l.inCompletenessAct !== undefined ? { inCompletenessAct: l.inCompletenessAct } : {}),
        ...(l.inDefectAct !== undefined ? { inDefectAct: l.inDefectAct } : {}),
        ...(l.sourceGroupId !== undefined ? { sourceGroupId: l.sourceGroupId } : {}),
      })),
    },
    ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata as PartMetadata } : {}),
  });
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
    statusIn: z
      .string()
      .optional()
      .transform((s) => (s === undefined ? undefined : s.split(',').map((x) => x.trim()).filter(Boolean))),
    excludeCancelled: z
      .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
      .optional()
      .transform((v) => v === 'true' || v === '1'),
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
    ...(parsed.data.statusIn !== undefined ? { statusIn: parsed.data.statusIn } : {}),
    ...(parsed.data.excludeCancelled === true ? { excludeCancelled: true } : {}),
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
    contractSectionNumber: z.string().nullable().optional(),
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
    ...(parsed.data.contractSectionNumber !== undefined ? { contractSectionNumber: parsed.data.contractSectionNumber } : {}),
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
    engineBrandId: z.string().uuid().optional(),
    engineBrandIds: z.array(z.string().uuid()).optional(),
    engineNomenclatureId: z.string().uuid().optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseAssemblyBoms({
    ...(parsed.data.engineBrandIds ? { engineBrandIds: parsed.data.engineBrandIds } : {}),
    ...(parsed.data.engineBrandId ? { engineBrandId: parsed.data.engineBrandId } : {}),
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
    // С v1.21.5 backend больше не пересчитывает priority строк BOM при изменении схемы:
    // priority контролирует клиент. Чтобы пересортировать строки конкретной BOM по новому
    // sortOrder, оператор открывает карточку BOM и нажимает кнопку «Пересортировать по схеме».
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

warehouseRouter.delete('/assembly-bom/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await deleteWarehouseAssemblyBom({
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

warehouseRouter.post('/assembly-bom', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(1),
    engineBrandIds: z.array(z.string().uuid()).min(1),
    engineNomenclatureId: z.string().uuid().optional().nullable(),
    version: z.coerce.number().int().min(1).optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    isDefault: z.boolean().optional(),
    notes: z.string().nullable().optional(),
    lines: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          componentNomenclatureId: z.string().uuid(),
          // componentType — произвольный typeId из глобальной схемы BOM (включая кастомные после
          // переименования: например, 'block' вместо 'carter'). Раньше тут был жёсткий enum из 7
          // значений — он молча отбрасывал кастомные типы, и пользовательский выбор «исчезал».
          componentType: z.string().min(1).max(64).optional(),
          qtyPerUnit: z.coerce.number().int().min(0),
          variantGroup: z.string().nullable().optional(),
          lineKey: z.string().nullable().optional(),
          parentLineKey: z.string().nullable().optional(),
          isRequired: z.boolean().optional(),
          priority: z.coerce.number().int().optional(),
          notes: z.string().nullable().optional(),
          normPercent: z.number().positive().nullable().optional(),
          positionKey: z.string().nullable().optional(),
          positionLabel: z.string().nullable().optional(),
          isDefaultOption: z.boolean().optional(),
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
    engineBrandIds: parsed.data.engineBrandIds,
    ...(parsed.data.engineNomenclatureId !== undefined ? { engineNomenclatureId: parsed.data.engineNomenclatureId } : {}),
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
      ...(line.normPercent !== undefined ? { normPercent: line.normPercent } : {}),
      ...(line.positionKey !== undefined ? { positionKey: line.positionKey } : {}),
      ...(line.positionLabel !== undefined ? { positionLabel: line.positionLabel } : {}),
      ...(line.isDefaultOption !== undefined ? { isDefaultOption: line.isDefaultOption } : {}),
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
  return res.status(410).json({
    ok: false,
    error: 'Режим default/active отключен: для каждого двигателя используется единая активная BOM.',
  });
});

warehouseRouter.post('/assembly-bom/:id/archive', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: 'Архивирование BOM отключено: используется единая рабочая спецификация на двигатель.',
  });
});

warehouseRouter.get('/assembly-bom/:engineBrandId/history', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const engineBrandId = String(req.params.engineBrandId || '').trim();
  if (!engineBrandId) return res.status(400).json({ ok: false, error: 'engineBrandId обязателен' });
  const result = await listWarehouseAssemblyBomHistory({ engineBrandId });
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
        engineId: z.string().uuid().nullable().optional(),
        workOrderId: z.string().uuid().nullable().optional(),
        workOrderNo: z.string().nullable().optional(),
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
    clientOperationId: z.string().uuid().optional(),
    expectedUpdatedAt: z.coerce.number().int().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const clientOperationId = parsed.data.clientOperationId ? String(parsed.data.clientOperationId) : '';
  const clientId = String(req.header('x-client-id') || req.header('x-clientid') || user?.id || 'unknown');
  if (clientOperationId) {
    const cached = await getIdempotentCommandResult({ clientId, clientOperationId });
    if (cached && cached.ok === true) return res.json(cached);
  }
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
            ...(parsed.data.header.engineId !== undefined ? { engineId: parsed.data.header.engineId } : {}),
            ...(parsed.data.header.workOrderId !== undefined ? { workOrderId: parsed.data.header.workOrderId } : {}),
            ...(parsed.data.header.workOrderNo !== undefined ? { workOrderNo: parsed.data.header.workOrderNo } : {}),
          },
        }
      : {}),
    ...(parsed.data.payloadJson !== undefined ? { payloadJson: parsed.data.payloadJson } : {}),
    ...(parsed.data.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: parsed.data.expectedUpdatedAt } : {}),
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  if (clientOperationId) {
    await saveIdempotentCommandResult({
      clientId,
      clientOperationId,
      commandType: 'warehouse_document_upsert',
      aggregateId: parsed.data.id ?? result.id,
      request: req.body as Record<string, unknown>,
      response: result as Record<string, unknown>,
    });
  }
  return res.json(result);
});

warehouseRouter.post('/documents/:id/plan', requirePermission(PermissionCode.ErpDocumentsEdit), async (req, res) => {
  const bodySchema = z.object({
    expectedUpdatedAt: z.coerce.number().int().optional(),
  });
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const parsedBody = bodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) return res.status(400).json({ ok: false, error: parsedBody.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await planWarehouseDocument({
    documentId: id,
    ...(parsedBody.data.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: parsedBody.data.expectedUpdatedAt } : {}),
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
  const bodySchema = z.object({
    expectedUpdatedAt: z.coerce.number().int().optional(),
  });
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const parsedBody = bodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) return res.status(400).json({ ok: false, error: parsedBody.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await postWarehouseDocument({
    documentId: id,
    ...(parsedBody.data.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: parsedBody.data.expectedUpdatedAt } : {}),
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Ф4 (G5): сторно проведённого документа — авто-документ с зеркальными reversal-движениями.
warehouseRouter.post('/documents/:id/reverse', requirePermission(PermissionCode.MovementsRevert), async (req, res) => {
  const bodySchema = z.object({
    expectedUpdatedAt: z.coerce.number().int().optional(),
  });
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const parsedBody = bodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) return res.status(400).json({ ok: false, error: parsedBody.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await reverseWarehouseDocument({
    documentId: id,
    ...(parsedBody.data.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: parsedBody.data.expectedUpdatedAt } : {}),
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Ремфонд Ф1: занос годных к ремонту деталей двигателя в ремонтный фонд из дефектовки.
warehouseRouter.post('/repair-fund/intake-from-engine', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {
  const schema = z.object({
    engineId: z.string().min(1),
    items: z
      .array(
        z.object({
          partId: z.string().min(1),
          partLabel: z.string().optional().default(''),
          qty: z.coerce.number().int(),
        }),
      )
      .default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await intakeRepairFundFromEngine({
    engineId: parsed.data.engineId,
    items: parsed.data.items.map((i) => ({ partId: i.partId, partLabel: i.partLabel, qty: i.qty })),
    actor: { id: String(user?.id ?? ''), username: String(user?.username ?? 'unknown') },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Ф3 forecast-remfond-aware: read-only превью дельты заноса (бейдж «дефектовка не занесена»).
warehouseRouter.post('/repair-fund/intake-preview', requirePermission(PermissionCode.ErpDocumentsView), async (req, res) => {
  const schema = z.object({
    engineId: z.string().min(1),
    items: z
      .array(
        z.object({
          partId: z.string().min(1),
          partLabel: z.string().optional().default(''),
          qty: z.coerce.number().int(),
        }),
      )
      .default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await previewRepairFundIntakeFromEngine({
    engineId: parsed.data.engineId,
    items: parsed.data.items.map((i) => ({ partId: i.partId, partLabel: i.partLabel, qty: i.qty })),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Ф6 (G6): списание утиля дефектовки двигателя в scrap-локацию (идемпотентно, high-water-mark).
warehouseRouter.post('/scrap/intake-from-engine', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {
  const schema = z.object({
    engineId: z.string().min(1),
    items: z
      .array(
        z.object({
          partId: z.string().min(1),
          partLabel: z.string().optional().default(''),
          qty: z.coerce.number().int(),
        }),
      )
      .default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await intakeScrapFromEngine({
    engineId: parsed.data.engineId,
    items: parsed.data.items.map((i) => ({ partId: i.partId, partLabel: i.partLabel, qty: i.qty })),
    actor: { id: String(user?.id ?? ''), username: String(user?.username ?? 'unknown') },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Ф6 (G6): read-only превью дельты списания утиля (бейдж «утиль не списан в локацию»).
warehouseRouter.post('/scrap/intake-preview', requirePermission(PermissionCode.ErpDocumentsView), async (req, res) => {
  const schema = z.object({
    engineId: z.string().min(1),
    items: z
      .array(
        z.object({
          partId: z.string().min(1),
          partLabel: z.string().optional().default(''),
          qty: z.coerce.number().int(),
        }),
      )
      .default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await previewScrapIntakeFromEngine({
    engineId: parsed.data.engineId,
    items: parsed.data.items.map((i) => ({ partId: i.partId, partLabel: i.partLabel, qty: i.qty })),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Ремфонд Ф3: захват номерных экземпляров деталей двигателя (личные набитые номера).
warehouseRouter.post('/repair-fund/instances/capture-from-engine', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {
  const schema = z.object({
    engineId: z.string().min(1),
    instances: z
      .array(
        z.object({
          partId: z.string().min(1),
          partLabel: z.string().optional().default(''),
          stampedNumber: z.string().min(1),
          classification: z.enum(['repairable', 'scrap', 'replace']).optional().default('repairable'),
        }),
      )
      .default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await captureStampedInstancesFromEngine({
    engineId: parsed.data.engineId,
    instances: parsed.data.instances.map((i) => ({
      partId: i.partId,
      partLabel: i.partLabel,
      stampedNumber: i.stampedNumber,
      classification: i.classification,
    })),
    actor: { id: String(user?.id ?? ''), username: String(user?.username ?? 'unknown'), role: String(user?.role ?? 'user') },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Ф3.1: ручная отметка экземпляра «отремонтирована» (in_fund↔repaired) с карточки двигателя.
warehouseRouter.post('/repair-fund/instances/:id/repaired', requirePermission(PermissionCode.ErpDocumentsPost), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const schema = z.object({ repaired: z.boolean().optional().default(true) });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const result = await setStampedInstanceRepaired({
    operationId: id,
    repaired: parsed.data.repaired,
    actor: { id: String(user?.id ?? ''), username: String(user?.username ?? 'unknown'), role: String(user?.role ?? 'user') },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/documents/:id/cancel', requirePermission(PermissionCode.ErpDocumentsEdit), async (req, res) => {
  const bodySchema = z.object({
    clientOperationId: z.string().uuid().optional(),
    expectedUpdatedAt: z.coerce.number().int().optional(),
  });
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const parsedBody = bodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) return res.status(400).json({ ok: false, error: parsedBody.error.flatten() });
  const user = (req as any).user as { id?: string; username?: string; role?: string } | undefined;
  const clientOperationId = parsedBody.data.clientOperationId ? String(parsedBody.data.clientOperationId) : '';
  const clientId = String(req.header('x-client-id') || req.header('x-clientid') || user?.id || 'unknown');
  if (clientOperationId) {
    const cached = await getIdempotentCommandResult({ clientId, clientOperationId });
    if (cached && cached.ok === true) return res.json(cached);
  }
  const result = await cancelWarehouseDocument({
    documentId: id,
    ...(parsedBody.data.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: parsedBody.data.expectedUpdatedAt } : {}),
    actor: {
      id: String(user?.id ?? ''),
      username: String(user?.username ?? 'unknown'),
      role: String(user?.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  if (clientOperationId) {
    await saveIdempotentCommandResult({
      clientId,
      clientOperationId,
      commandType: 'warehouse_document_cancel',
      aggregateId: id,
      request: { id, ...(req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}) },
      response: result as Record<string, unknown>,
    });
  }
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
    sameBrandBatchSize: z.coerce.number().int().min(1).max(500).optional(),
    horizonDays: z.coerce.number().int().min(1).max(31).optional(),
    warehouseIds: z.array(z.string().min(1)).optional(),
    engineBrandIds: z.array(z.string().uuid()).optional(),
    priorityEngineBrandIds: z.array(z.string().uuid()).optional(),
    workingWeekdays: z.array(z.coerce.number().int().min(0).max(6)).optional(),
    brandMaxEnginesHorizon: z.record(z.string().min(1), z.coerce.number().int().min(0).max(100_000)).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  try {
    const forecast = await computeAssemblyForecastFromServer({
      targetEnginesPerDay: parsed.data.targetEnginesPerDay,
      ...(parsed.data.sameBrandBatchSize !== undefined ? { sameBrandBatchSize: parsed.data.sameBrandBatchSize } : {}),
      ...(parsed.data.horizonDays !== undefined ? { horizonDays: parsed.data.horizonDays } : {}),
      ...(parsed.data.warehouseIds !== undefined ? { warehouseIds: parsed.data.warehouseIds } : {}),
      ...(parsed.data.engineBrandIds !== undefined ? { engineBrandIds: parsed.data.engineBrandIds } : {}),
      ...(parsed.data.priorityEngineBrandIds !== undefined ? { priorityEngineBrandIds: parsed.data.priorityEngineBrandIds } : {}),
      ...(parsed.data.workingWeekdays !== undefined ? { workingWeekdays: parsed.data.workingWeekdays } : {}),
      ...(parsed.data.brandMaxEnginesHorizon !== undefined ? { brandMaxEnginesHorizon: parsed.data.brandMaxEnginesHorizon } : {}),
    });
    /** Коды статуса как в `computeAssemblyForecast` (`ok` | `waiting` | `shortage` | `absent` | `weekend`); подписи для UI делает клиент. */
    // Hotfix v1.29.1: пробрасываем requiredParts + variantKey из shared/computeAssemblyForecast.
    // В v1.29.0 этот map сужал row до 8 полей и Stage 4-кнопка «Создать наряд на сборку»
    // не рендерилась (UI получал пустые _assemblyRequiredPartsJson/_assemblyVariantKey).
    const rows = forecast.rows.map((r) => ({
      dayLabel: r.dayLabel,
      engineBrand: r.engineBrand,
      brandId: r.brandId,
      plannedEngines: r.plannedEngines,
      status: r.status,
      requiredComponentsSummary: r.requiredComponentsSummary,
      deficitsSummary: r.deficitsSummary,
      alternativeBrands: r.alternativeBrands,
      ...(r.requiredParts !== undefined ? { requiredParts: r.requiredParts } : {}),
      ...(r.variantKey !== undefined ? { variantKey: r.variantKey } : {}),
    }));
    return res.json({
      ok: true,
      rows,
      warnings: forecast.warnings,
      deficitRecommendations: forecast.deficitRecommendations,
      horizonMissingByBrand: forecast.horizonMissingByBrand,
      horizonComponentNeeds: forecast.horizonComponentNeeds,
      // Hotfix v1.29.1: без этого Map UI не блокирует кнопку «Создать наряд» для уже выписанных.
      ...(forecast.existingAssemblyOrdersByVariantKey !== undefined
        ? { existingAssemblyOrdersByVariantKey: forecast.existingAssemblyOrdersByVariantKey }
        : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

warehouseRouter.get('/forecast/bom', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const schema = z.object({
    engineBrandId: z.string().uuid(),
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
    engineBrandId: parsed.data.engineBrandId,
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

warehouseRouter.get('/contracts/:contractId/sections', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const contractId = String(req.params.contractId || '').trim();
  if (!contractId) return res.status(400).json({ ok: false, error: 'contractId обязателен' });
  const result = await getContractSections(contractId);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
