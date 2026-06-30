import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { analyzeEngineDuplicates, mergeEngineGroup } from '../services/engineDedupeService.js';

export const enginesRouter = Router();

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
