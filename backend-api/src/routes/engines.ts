import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { analyzeEngineDuplicates, mergeEngineGroup } from '../services/engineDedupeService.js';
import {
  acquireEngineReservation,
  getEngineReservation,
  releaseEngineReservation,
  type ReservationActor,
} from '../services/engineReservationService.js';

export const enginesRouter = Router();

function reservationActor(req: unknown): ReservationActor {
  const user = (req as { user?: { id?: string; username?: string; role?: string } }).user;
  return {
    id: String(user?.id ?? ''),
    username: String(user?.username ?? 'unknown'),
    role: String(user?.role ?? 'user'),
  };
}

// Advisory-резервирование двигателя (Ф2 tablet-shop-floor). Резерв server-managed:
// клиент его только читает из реплики, а меняет ТОЛЬКО через эти три эндпойнта —
// серверные часы снимают скос часов планшета, CAS снимает гонку одновременного взятия.
enginesRouter.get(
  '/:engineId/reservation',
  requireAuth,
  requirePermission(PermissionCode.EnginesView),
  async (req, res) => {
    const result = await getEngineReservation(String(req.params.engineId));
    return res.json(result);
  },
);

enginesRouter.post(
  '/:engineId/reservation',
  requireAuth,
  requirePermission(PermissionCode.EnginesEdit),
  async (req, res) => {
    const result = await acquireEngineReservation({
      engineId: String(req.params.engineId),
      actor: reservationActor(req),
    });
    if (!result.ok) return res.status(result.status).json(result);
    return res.json(result);
  },
);

enginesRouter.delete(
  '/:engineId/reservation',
  requireAuth,
  requirePermission(PermissionCode.EnginesEdit),
  async (req, res) => {
    const actor = reservationActor(req);
    const role = String(actor.role ?? '').toLowerCase();
    const result = await releaseEngineReservation({
      engineId: String(req.params.engineId),
      actor,
      byAdmin: role === 'admin' || role === 'superadmin',
    });
    if (!result.ok) return res.status(result.status).json(result);
    return res.json(result);
  },
);

// Operator-driven engine dedupe (UI "Поиск дублей двигателей"). Analyze is read-only
// (engines.view); merge is a destructive consolidation (engines.edit).
enginesRouter.get('/dedupe', requireAuth, requirePermission(PermissionCode.EnginesView), async (_req, res) => {
  const result = await analyzeEngineDuplicates();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

enginesRouter.post('/dedupe/merge', requireAuth, requirePermission(PermissionCode.EnginesEdit), async (req, res) => {
  const schema = z.object({ survivorId: z.string().min(1), loserIds: z.array(z.string().min(1)).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as unknown as { user?: { id?: string; username?: string; role?: string } }).user;
  const result = await mergeEngineGroup({
    survivorId: parsed.data.survivorId,
    loserIds: parsed.data.loserIds,
    actor: { id: String(user?.id ?? ''), username: String(user?.username ?? 'unknown'), role: String(user?.role ?? 'user') },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
