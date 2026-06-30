import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  createRepairTemplate,
  deleteRepairTemplate,
  getRepairTemplate,
  getRepairTemplateById,
  listRepairTemplates,
  setRepairTemplate,
  updateRepairTemplate,
} from '../services/workshopRepairTemplateService.js';
import { deleteWorkshop, listWorkshops, upsertWorkshop } from '../services/workshopsService.js';
import { getWorkshopStats } from '../services/workshopStatsService.js';

export const workshopsRouter = Router();
workshopsRouter.use(requireAuth);

workshopsRouter.get('/', requirePermission(PermissionCode.MasterDataView), async (req, res) => {
  const activeOnly = String(req.query.activeOnly ?? '').toLowerCase() === 'true';
  const result = await listWorkshops({ activeOnly });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// «Статистика цехов» (Phase 0): труд + прохождение двигателей по цехам из нарядов.
workshopsRouter.get('/stats', requirePermission(PermissionCode.ErpRegistersView), async (req, res) => {
  const result = await getWorkshopStats({
    ...(typeof req.query.from === 'string' ? { from: req.query.from } : {}),
    ...(typeof req.query.to === 'string' ? { to: req.query.to } : {}),
    ...(typeof req.query.workshopId === 'string' ? { workshopId: req.query.workshopId } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

workshopsRouter.post('/', requirePermission(PermissionCode.WorkshopsManage), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    code: z.string().min(1),
    name: z.string().min(1),
    isActive: z.boolean().optional(),
    displayOrder: z.number().int().nonnegative().optional(),
    metadataJson: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWorkshop({
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    code: parsed.data.code,
    name: parsed.data.name,
    ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
    ...(parsed.data.displayOrder !== undefined ? { displayOrder: parsed.data.displayOrder } : {}),
    ...(parsed.data.metadataJson !== undefined ? { metadataJson: parsed.data.metadataJson } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

workshopsRouter.delete('/:id', requirePermission(PermissionCode.WorkshopsManage), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
  const result = await deleteWorkshop({ id });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Legacy /repair-template(s) endpoints (v1.26/v1.27) — superseded by the universal
// /work-order-templates router (Stage 2 of work-order-template-system plan).
// We keep these alive for one release cycle so existing clients keep working until
// the UI rollout in Stage 5 switches to the new router. Removal is planned for PR 6.
function markDeprecated(_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</work-order-templates>; rel="successor-version"');
  next();
}
workshopsRouter.use('/:id/repair-template', markDeprecated);
workshopsRouter.use('/:id/repair-templates', markDeprecated);

// GET — открыт всем с правом создания нарядов (нужно для autofill freeWorks
// при создании Workshop-наряда). PUT — только WorkshopRepairTemplatesEdit
// (adminOnly), потому что одна правка шаблона влияет на все будущие наряды цеха.
workshopsRouter.get(
  '/:id/repair-template',
  requirePermission(PermissionCode.WorkOrdersCreate),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const result = await getRepairTemplate(id);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

workshopsRouter.put(
  '/:id/repair-template',
  requirePermission(PermissionCode.WorkshopRepairTemplatesEdit),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const schema = z.object({
      lines: z.array(
        z.object({
          nomenclatureId: z.string().min(1),
          unit: z.string().min(1),
          defaultQty: z.number().nonnegative().optional(),
          serviceId: z.string().min(1).optional(),
        }),
      ),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user?.username ?? null;
    const result = await setRepairTemplate({ workshopId: id, lines: parsed.data.lines, actor });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

// ─── Multi-template CRUD (v1.27.0) ───────────────────────────────────────────
// Множественные шаблоны на цех. GET — открыт всем с правом создания нарядов.
// POST/PUT/DELETE — WorkshopRepairTemplatesEdit (adminOnly).

const templateLineSchema = z.object({
  nomenclatureId: z.string().min(1),
  unit: z.string().min(1),
  defaultQty: z.number().nonnegative().optional(),
  serviceId: z.string().min(1).optional(),
});

workshopsRouter.get(
  '/:id/repair-templates',
  requirePermission(PermissionCode.WorkOrdersCreate),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const result = await listRepairTemplates(id);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

workshopsRouter.get(
  '/:id/repair-templates/:templateId',
  requirePermission(PermissionCode.WorkOrdersCreate),
  async (req, res) => {
    const templateId = String(req.params.templateId || '').trim();
    if (!templateId) return res.status(400).json({ ok: false, error: 'templateId обязателен' });
    const result = await getRepairTemplateById(templateId);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

workshopsRouter.post(
  '/:id/repair-templates',
  requirePermission(PermissionCode.WorkshopRepairTemplatesEdit),
  async (req, res) => {
    const workshopId = String(req.params.id || '').trim();
    if (!workshopId) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const schema = z.object({
      name: z.string().min(1).max(100),
      lines: z.array(templateLineSchema),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user?.username ?? null;
    const result = await createRepairTemplate({
      workshopId,
      name: parsed.data.name,
      lines: parsed.data.lines,
      actor,
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

workshopsRouter.put(
  '/:id/repair-templates/:templateId',
  requirePermission(PermissionCode.WorkshopRepairTemplatesEdit),
  async (req, res) => {
    const templateId = String(req.params.templateId || '').trim();
    if (!templateId) return res.status(400).json({ ok: false, error: 'templateId обязателен' });
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      lines: z.array(templateLineSchema).optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user?.username ?? null;
    const result = await updateRepairTemplate({
      id: templateId,
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.lines !== undefined ? { lines: parsed.data.lines } : {}),
      actor,
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

workshopsRouter.delete(
  '/:id/repair-templates/:templateId',
  requirePermission(PermissionCode.WorkshopRepairTemplatesEdit),
  async (req, res) => {
    const templateId = String(req.params.templateId || '').trim();
    if (!templateId) return res.status(400).json({ ok: false, error: 'templateId обязателен' });
    const result = await deleteRepairTemplate(templateId);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);
