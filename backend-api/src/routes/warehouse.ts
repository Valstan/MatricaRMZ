import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  cancelWarehouseDocument,
  createWarehouseDocument,
  deleteWarehouseNomenclature,
  getWarehouseDocument,
  listWarehouseLookups,
  listWarehouseDocuments,
  listWarehouseMovements,
  listWarehouseNomenclature,
  listWarehouseStock,
  postWarehouseDocument,
  upsertWarehouseNomenclature,
} from '../services/warehouseService.js';

export const warehouseRouter = Router();
warehouseRouter.use(requireAuth);

warehouseRouter.get('/lookups', requirePermission(PermissionCode.ErpDictionaryView), async (_req, res) => {
  const result = await listWarehouseLookups();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.get('/nomenclature', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const schema = z.object({
    search: z.string().optional(),
    itemType: z.string().optional(),
    groupId: z.string().optional(),
    isActive: z.coerce.boolean().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseNomenclature({
    ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
    ...(parsed.data.itemType !== undefined ? { itemType: parsed.data.itemType } : {}),
    ...(parsed.data.groupId !== undefined ? { groupId: parsed.data.groupId } : {}),
    ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseRouter.post('/nomenclature', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    code: z.string().min(1),
    name: z.string().min(1),
    itemType: z.string().optional(),
    groupId: z.string().uuid().nullable().optional(),
    unitId: z.string().uuid().nullable().optional(),
    barcode: z.string().nullable().optional(),
    minStock: z.coerce.number().int().nullable().optional(),
    maxStock: z.coerce.number().int().nullable().optional(),
    defaultWarehouseId: z.string().nullable().optional(),
    specJson: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWarehouseNomenclature({
    code: parsed.data.code,
    name: parsed.data.name,
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    ...(parsed.data.itemType !== undefined ? { itemType: parsed.data.itemType } : {}),
    ...(parsed.data.groupId !== undefined ? { groupId: parsed.data.groupId } : {}),
    ...(parsed.data.unitId !== undefined ? { unitId: parsed.data.unitId } : {}),
    ...(parsed.data.barcode !== undefined ? { barcode: parsed.data.barcode } : {}),
    ...(parsed.data.minStock !== undefined ? { minStock: parsed.data.minStock } : {}),
    ...(parsed.data.maxStock !== undefined ? { maxStock: parsed.data.maxStock } : {}),
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

warehouseRouter.get('/stock', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const schema = z.object({
    warehouseId: z.string().optional(),
    nomenclatureId: z.string().uuid().optional(),
    search: z.string().optional(),
    lowStockOnly: z.coerce.boolean().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listWarehouseStock({
    ...(parsed.data.warehouseId !== undefined ? { warehouseId: parsed.data.warehouseId } : {}),
    ...(parsed.data.nomenclatureId !== undefined ? { nomenclatureId: parsed.data.nomenclatureId } : {}),
    ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
    ...(parsed.data.lowStockOnly !== undefined ? { lowStockOnly: parsed.data.lowStockOnly } : {}),
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
  });
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
    docNo: z.string().min(1),
    docDate: z.coerce.number().int().optional(),
    departmentId: z.string().nullable().optional(),
    authorId: z.string().uuid().nullable().optional(),
    header: z
      .object({
        warehouseId: z.string().nullable().optional(),
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
          partCardId: z.string().uuid().nullable().optional(),
          nomenclatureId: z.string().uuid().nullable().optional(),
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
    docNo: parsed.data.docNo,
    lines: parsed.data.lines.map((line) => ({
      qty: line.qty,
      ...(line.price !== undefined ? { price: line.price } : {}),
      ...(line.partCardId !== undefined ? { partCardId: line.partCardId } : {}),
      ...(line.nomenclatureId !== undefined ? { nomenclatureId: line.nomenclatureId } : {}),
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
