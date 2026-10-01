import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  archiveRepairStageTemplate,
  deleteRepairStageTemplate,
  listRepairStageTemplates,
  mergeRepairStageTemplates,
  reorderRepairStageTemplates,
  restoreRepairStageTemplate,
  upsertRepairStageTemplate,
} from '../services/repairStageTemplateService.js';

/**
 * Шаблон единого списка этапов (план unified-repair-stages, шаг 5a). Читать может
 * любой, кто видит операции; вести шаблон — отдельное поимённое право
 * `repair_stage_templates.edit` (роль не даёт даже admin'у).
 */
export const repairStageTemplatesRouter = Router();
repairStageTemplatesRouter.use(requireAuth);

repairStageTemplatesRouter.get('/', requirePermission(PermissionCode.OperationsView), async (req, res) => {
  const includeArchived = String(req.query.includeArchived ?? '') === '1';
  const result = await listRepairStageTemplates({ includeArchived });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

repairStageTemplatesRouter.post('/', requirePermission(PermissionCode.RepairStageTemplatesEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    code: z.string().max(40).optional(),
    name: z.string().min(1).max(120),
    autoFrom: z.string().max(40).nullable().optional(),
    sideBranch: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    expectedUpdatedAt: z.number().int().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const actor = (req as AuthenticatedRequest).user?.username ?? null;
  const result = await upsertRepairStageTemplate({ ...parsed.data, actor });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

repairStageTemplatesRouter.post('/reorder', requirePermission(PermissionCode.RepairStageTemplatesEdit), async (req, res) => {
  const schema = z.object({ ids: z.array(z.string()).min(1).max(200) });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const actor = (req as AuthenticatedRequest).user?.username ?? null;
  const result = await reorderRepairStageTemplates(parsed.data.ids, actor);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

repairStageTemplatesRouter.post('/:id/archive', requirePermission(PermissionCode.RepairStageTemplatesEdit), async (req, res) => {
  const actor = (req as AuthenticatedRequest).user?.username ?? null;
  const result = await archiveRepairStageTemplate(String(req.params.id ?? ''), actor);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

repairStageTemplatesRouter.post('/:id/restore', requirePermission(PermissionCode.RepairStageTemplatesEdit), async (req, res) => {
  const actor = (req as AuthenticatedRequest).user?.username ?? null;
  const result = await restoreRepairStageTemplate(String(req.params.id ?? ''), actor);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

repairStageTemplatesRouter.post('/merge', requirePermission(PermissionCode.RepairStageTemplatesEdit), async (req, res) => {
  const schema = z.object({
    sourceId: z.string().min(1).max(100),
    targetId: z.string().min(1).max(100),
    dryRun: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as AuthenticatedRequest).user;
  const result = await mergeRepairStageTemplates(parsed.data.sourceId, parsed.data.targetId, {
    id: String(user?.id ?? ''),
    username: String(user?.username ?? ''),
    ...(user?.role ? { role: String(user.role) } : {}),
  }, { ...(parsed.data.dryRun === true ? { dryRun: true as const } : {}) });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

repairStageTemplatesRouter.post('/:id/delete', requirePermission(PermissionCode.RepairStageTemplatesEdit), async (req, res) => {
  const actor = (req as AuthenticatedRequest).user?.username ?? null;
  const result = await deleteRepairStageTemplate(String(req.params.id ?? ''), actor);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
