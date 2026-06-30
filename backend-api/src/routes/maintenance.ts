import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { analyzeEmptyCards, deleteEmptyCards } from '../services/emptyCardsService.js';

export const maintenanceRouter = Router();

// Operator-driven cleanup of empty auto-created cards/documents (UI «Пустые карточки»).
// Analyze is read-only (masterdata.view); delete is a destructive soft-delete (masterdata.edit).
maintenanceRouter.get('/empty-cards', requireAuth, requirePermission(PermissionCode.MasterDataView), async (_req, res) => {
  const result = await analyzeEmptyCards();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

maintenanceRouter.post('/empty-cards/delete', requireAuth, requirePermission(PermissionCode.MasterDataEdit), async (req, res) => {
  const schema = z.object({ ids: z.array(z.string().min(1)).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const user = (req as unknown as { user?: { id?: string; username?: string; role?: string } }).user;
  const result = await deleteEmptyCards({
    ids: parsed.data.ids,
    actor: { id: String(user?.id ?? ''), username: String(user?.username ?? 'unknown'), role: String(user?.role ?? 'user') },
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
