import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  closeWorkOrderAndPostDocument,
  deleteAssemblyWorkOrderDraft,
  postAssemblyReturn,
  postAssemblyWorkOrder,
  saveAssemblyWorkOrderDraft,
} from '../services/workOrderClosingService.js';

export const workOrdersRouter = Router();
workOrdersRouter.use(requireAuth);

workOrdersRouter.post('/:operationId/close', requirePermission(PermissionCode.WorkOrdersClose), async (req, res) => {
  const operationId = String(req.params.operationId || '').trim();
  if (!operationId) return res.status(400).json({ ok: false, error: 'operationId обязателен' });

  const bodySchema = z.object({
    expectedUpdatedAt: z.coerce.number().int().optional(),
  });
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  const user = (req as { user?: { id?: string; username?: string; role?: string } }).user ?? {};
  const result = await closeWorkOrderAndPostDocument({
    operationId,
    ...(parsed.data.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: parsed.data.expectedUpdatedAt } : {}),
    actor: {
      id: String(user.id ?? ''),
      username: String(user.username ?? 'unknown'),
      role: String(user.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// ─── Assembly work-order lifecycle (Stage 1 of assembly-work-order-from-forecast) ───
//
// Делит единое закрытие assembly-наряда на три шага:
//  save-assembly-draft  — создать assembly_consumption(draft) + зарезервировать детали.
//  post-assembly        — снять резерв, провести списание, закрыть наряд.
//  delete-assembly-draft — снять резерв, отменить документ, отвязать его от наряда.

function assemblyActorFromReq(req: unknown) {
  const user = ((req as { user?: { id?: string; username?: string; role?: string } }).user) ?? {};
  return {
    id: String(user.id ?? ''),
    username: String(user.username ?? 'unknown'),
    role: String(user.role ?? 'user'),
  };
}

const assemblyActionBodySchema = z.object({
  expectedUpdatedAt: z.coerce.number().int().optional(),
});

workOrdersRouter.post('/:operationId/save-assembly-draft', requirePermission(PermissionCode.WorkOrdersClose), async (req, res) => {
  const operationId = String(req.params.operationId || '').trim();
  if (!operationId) return res.status(400).json({ ok: false, error: 'operationId обязателен' });
  const parsed = assemblyActionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await saveAssemblyWorkOrderDraft({
    operationId,
    ...(parsed.data.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: parsed.data.expectedUpdatedAt } : {}),
    actor: assemblyActorFromReq(req),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

workOrdersRouter.post('/:operationId/post-assembly', requirePermission(PermissionCode.WorkOrdersClose), async (req, res) => {
  const operationId = String(req.params.operationId || '').trim();
  if (!operationId) return res.status(400).json({ ok: false, error: 'operationId обязателен' });
  const parsed = assemblyActionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await postAssemblyWorkOrder({
    operationId,
    ...(parsed.data.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: parsed.data.expectedUpdatedAt } : {}),
    actor: assemblyActorFromReq(req),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

workOrdersRouter.post('/:operationId/delete-assembly-draft', requirePermission(PermissionCode.WorkOrdersClose), async (req, res) => {
  const operationId = String(req.params.operationId || '').trim();
  if (!operationId) return res.status(400).json({ ok: false, error: 'operationId обязателен' });
  const parsed = assemblyActionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await deleteAssemblyWorkOrderDraft({
    operationId,
    ...(parsed.data.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: parsed.data.expectedUpdatedAt } : {}),
    actor: assemblyActorFromReq(req),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

workOrdersRouter.post('/assembly-return', requirePermission(PermissionCode.WarehouseAssemblyReturn), async (req, res) => {
  const bodySchema = z.object({
    engineId: z.string().uuid(),
    reason: z.string().nullable().optional(),
    lines: z
      .array(
        z.object({
          nomenclatureId: z.string().uuid(),
          qty: z.number().int().positive(),
          mode: z.enum(['rework', 'scrap']),
        }),
      )
      .min(1),
  });
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  const user = (req as { user?: { id?: string; username?: string; role?: string } }).user ?? {};
  const result = await postAssemblyReturn({
    engineId: parsed.data.engineId,
    ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
    lines: parsed.data.lines,
    actor: {
      id: String(user.id ?? ''),
      username: String(user.username ?? 'unknown'),
      role: String(user.role ?? 'user'),
    },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
