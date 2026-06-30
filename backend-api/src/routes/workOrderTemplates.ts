import { Router } from 'express';
import { z } from 'zod';

import { WORK_ORDER_TEMPLATE_KINDS, WORK_ORDER_TEMPLATE_NAME_MAX } from '@matricarmz/shared';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  createWorkOrderTemplate,
  deleteWorkOrderTemplate,
  getWorkOrderTemplateById,
  listWorkOrderTemplates,
  updateWorkOrderTemplate,
} from '../services/workOrderTemplateService.js';

export const workOrderTemplatesRouter = Router();
workOrderTemplatesRouter.use(requireAuth);

const kindSchema = z.enum(WORK_ORDER_TEMPLATE_KINDS as unknown as [string, ...string[]]);

const lineSchema = z
  .object({
    nomenclatureId: z.string().min(1).optional(),
    serviceId: z.string().min(1).optional(),
    serviceName: z.string().min(1).optional(),
    unit: z.string().min(1).optional(),
    defaultQty: z.number().nonnegative().optional(),
    productNumber: z.string().min(1).optional(),
    engineId: z.string().min(1).nullable().optional(),
    engineNumber: z.string().min(1).optional(),
    engineBrandId: z.string().min(1).nullable().optional(),
    engineBrandName: z.string().min(1).optional(),
  })
  .passthrough();

workOrderTemplatesRouter.get(
  '/',
  requirePermission(PermissionCode.WorkOrdersCreate),
  async (req, res) => {
    const rawKind = req.query.kind;
    const filter: { kind?: unknown } = {};
    if (rawKind !== undefined) filter.kind = String(rawKind);
    const result = await listWorkOrderTemplates(filter);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

workOrderTemplatesRouter.get(
  '/:id',
  requirePermission(PermissionCode.WorkOrdersCreate),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const result = await getWorkOrderTemplateById(id);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

workOrderTemplatesRouter.post(
  '/',
  requirePermission(PermissionCode.WorkOrderTemplatesEdit),
  async (req, res) => {
    const schema = z.object({
      workOrderKind: kindSchema,
      name: z.string().min(1).max(WORK_ORDER_TEMPLATE_NAME_MAX),
      payloadOverrides: z.record(z.unknown()).optional(),
      hiddenFields: z.array(z.string()).optional(),
      lines: z.array(lineSchema).optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user?.username ?? null;
    const result = await createWorkOrderTemplate({
      workOrderKind: parsed.data.workOrderKind,
      name: parsed.data.name,
      ...(parsed.data.payloadOverrides !== undefined ? { payloadOverrides: parsed.data.payloadOverrides } : {}),
      ...(parsed.data.hiddenFields !== undefined ? { hiddenFields: parsed.data.hiddenFields } : {}),
      ...(parsed.data.lines !== undefined ? { lines: parsed.data.lines } : {}),
      actor,
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

workOrderTemplatesRouter.put(
  '/:id',
  requirePermission(PermissionCode.WorkOrderTemplatesEdit),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const schema = z.object({
      name: z.string().min(1).max(WORK_ORDER_TEMPLATE_NAME_MAX).optional(),
      payloadOverrides: z.record(z.unknown()).optional(),
      hiddenFields: z.array(z.string()).optional(),
      lines: z.array(lineSchema).optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user?.username ?? null;
    const result = await updateWorkOrderTemplate({
      id,
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.payloadOverrides !== undefined ? { payloadOverrides: parsed.data.payloadOverrides } : {}),
      ...(parsed.data.hiddenFields !== undefined ? { hiddenFields: parsed.data.hiddenFields } : {}),
      ...(parsed.data.lines !== undefined ? { lines: parsed.data.lines } : {}),
      actor,
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

workOrderTemplatesRouter.delete(
  '/:id',
  requirePermission(PermissionCode.WorkOrderTemplatesEdit),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const result = await deleteWorkOrderTemplate(id);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);
