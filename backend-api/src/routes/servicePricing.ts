import { Router } from 'express';
import { z } from 'zod';

import { PermissionCode } from '../auth/permissions.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import {
  deleteServicePriceOrder,
  getCurrentServicePrice,
  listServicePriceHistory,
  listServicePriceOrders,
  setServicePriceByOrder,
  upsertServicePriceOrder,
} from '../services/servicePricingService.js';

export const servicePricingRouter = Router();

servicePricingRouter.use(requireAuth);

servicePricingRouter.get('/orders', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const schema = z.object({
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(2000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listServicePriceOrders({
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

servicePricingRouter.post('/orders', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    orderNumber: z.string().min(1),
    orderDate: z.coerce.number().int(),
    title: z.string().min(1),
    notes: z.string().nullable().optional(),
    documentLink: z.string().nullable().optional(),
    issuedByEmployeeId: z.string().uuid().nullable().optional(),
    effectiveFrom: z.coerce.number().int(),
    status: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertServicePriceOrder({
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    orderNumber: parsed.data.orderNumber,
    orderDate: parsed.data.orderDate,
    title: parsed.data.title,
    effectiveFrom: parsed.data.effectiveFrom,
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    ...(parsed.data.documentLink !== undefined ? { documentLink: parsed.data.documentLink } : {}),
    ...(parsed.data.issuedByEmployeeId !== undefined ? { issuedByEmployeeId: parsed.data.issuedByEmployeeId } : {}),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

servicePricingRouter.delete('/orders/:id', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const result = await deleteServicePriceOrder(id);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

servicePricingRouter.get('/history', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const schema = z.object({
    nomenclatureId: z.string().uuid().optional(),
    orderId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(5000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await listServicePriceHistory({
    ...(parsed.data.nomenclatureId !== undefined ? { nomenclatureId: parsed.data.nomenclatureId } : {}),
    ...(parsed.data.orderId !== undefined ? { orderId: parsed.data.orderId } : {}),
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

servicePricingRouter.post('/history', requirePermission(PermissionCode.ErpDictionaryEdit), async (req, res) => {
  const schema = z.object({
    nomenclatureId: z.string().uuid(),
    orderId: z.string().uuid(),
    price: z.coerce.number(),
    priceCurrency: z.string().optional(),
    effectiveFrom: z.coerce.number().int().optional(),
    notes: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await setServicePriceByOrder({
    nomenclatureId: parsed.data.nomenclatureId,
    orderId: parsed.data.orderId,
    price: parsed.data.price,
    ...(parsed.data.priceCurrency !== undefined ? { priceCurrency: parsed.data.priceCurrency } : {}),
    ...(parsed.data.effectiveFrom !== undefined ? { effectiveFrom: parsed.data.effectiveFrom } : {}),
    ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

servicePricingRouter.get('/current/:nomenclatureId', requirePermission(PermissionCode.ErpDictionaryView), async (req, res) => {
  const id = String(req.params.nomenclatureId ?? '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'nomenclatureId required' });
  const result = await getCurrentServicePrice(id);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
