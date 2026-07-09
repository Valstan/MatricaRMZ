import { Router } from 'express';
import { z } from 'zod';

import { ENGINE_ACT_TEMPLATE_NAME_MAX } from '@matricarmz/shared';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  createEngineActTemplate,
  deleteEngineActTemplate,
  getEngineActTemplateById,
  listEngineActTemplates,
  updateEngineActTemplate,
} from '../services/engineActTemplateService.js';

export const engineActTemplatesRouter = Router();
engineActTemplatesRouter.use(requireAuth);

const payloadSchema = z
  .object({
    commissionMembers: z.array(z.record(z.unknown())).optional(),
    approverGrif: z.record(z.unknown()).optional(),
    conditionItems: z.array(z.object({ id: z.string(), label: z.string() }).passthrough()).optional(),
  })
  .passthrough();

engineActTemplatesRouter.get(
  '/',
  requirePermission(PermissionCode.OperationsView),
  async (req, res) => {
    const rawBrand = req.query.engineBrandId;
    const filter: { engineBrandId?: unknown } = {};
    if (rawBrand !== undefined) filter.engineBrandId = String(rawBrand);
    const result = await listEngineActTemplates(filter);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

engineActTemplatesRouter.get(
  '/:id',
  requirePermission(PermissionCode.OperationsView),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const result = await getEngineActTemplateById(id);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

engineActTemplatesRouter.post(
  '/',
  requirePermission(PermissionCode.EngineActTemplatesEdit),
  async (req, res) => {
    const schema = z.object({
      engineBrandId: z.string().min(1),
      name: z.string().min(1).max(ENGINE_ACT_TEMPLATE_NAME_MAX),
      payload: payloadSchema.optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user?.username ?? null;
    const result = await createEngineActTemplate({
      engineBrandId: parsed.data.engineBrandId,
      name: parsed.data.name,
      ...(parsed.data.payload !== undefined ? { payload: parsed.data.payload } : {}),
      actor,
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

engineActTemplatesRouter.put(
  '/:id',
  requirePermission(PermissionCode.EngineActTemplatesEdit),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const schema = z.object({
      name: z.string().min(1).max(ENGINE_ACT_TEMPLATE_NAME_MAX).optional(),
      payload: payloadSchema.optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user?.username ?? null;
    const result = await updateEngineActTemplate({
      id,
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.payload !== undefined ? { payload: parsed.data.payload } : {}),
      actor,
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

engineActTemplatesRouter.delete(
  '/:id',
  requirePermission(PermissionCode.EngineActTemplatesEdit),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const result = await deleteEngineActTemplate(id);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);
