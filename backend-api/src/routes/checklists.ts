import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { getRepairChecklistForEngine, listRepairChecklistTemplates, saveRepairChecklistForEngine } from '../services/checklistService.js';

export const checklistsRouter = Router();

checklistsRouter.use(requireAuth);

checklistsRouter.get('/templates', requirePermission(PermissionCode.OperationsView), async (req, res) => {
  const stage = req.query?.stage ? String(req.query.stage) : undefined;
  const r = await listRepairChecklistTemplates(stage);
  return res.json(r);
});

checklistsRouter.get('/engine', requirePermission(PermissionCode.OperationsView), async (req, res) => {
  const engineId = String(req.query?.engineId ?? '');
  const stage = String(req.query?.stage ?? '');
  if (!engineId || !stage) return res.status(400).json({ ok: false, error: 'engineId and stage required' });
  const t = await listRepairChecklistTemplates(stage);
  if (!t.ok) return res.json(t);
  const r = await getRepairChecklistForEngine(engineId, stage);
  if (!r.ok) return res.json(r);
  return res.json({ ok: true as const, operationId: r.operationId, payload: r.payload, templates: t.templates });
});

checklistsRouter.post('/engine', requirePermission(PermissionCode.OperationsEdit), async (req, res) => {
  const schema = z.object({
    engineId: z.string().uuid(),
    stage: z.string().min(1),
    templateId: z.string().min(1),
    operationId: z.string().uuid().nullable().optional(),
    answers: z.record(z.any()).optional(),
    attachments: z.array(z.any()).optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const data = parsed.data;

  const t = await listRepairChecklistTemplates(data.stage);
  if (!t.ok) return res.json(t);
  const tmpl = t.templates.find((x) => x.id === data.templateId) ?? null;
  if (!tmpl) return res.status(400).json({ ok: false, error: 'template not found' });

  const actor = (req as unknown as AuthenticatedRequest).user;
  const payload = {
    kind: 'repair_checklist' as const,
    templateId: tmpl.id,
    templateVersion: tmpl.version,
    stage: data.stage,
    engineEntityId: data.engineId,
    filledBy: actor?.username ?? null,
    filledAt: Date.now(),
    answers: data.answers ?? {},
    attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
  };

  const r = await saveRepairChecklistForEngine({
    engineId: data.engineId,
    stage: data.stage,
    operationId: data.operationId ?? null,
    payload,
    actor: { id: actor.id, username: actor.username },
  });
  return res.json(r);
});
