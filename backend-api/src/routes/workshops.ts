import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { deleteWorkshop, listWorkshops, upsertWorkshop } from '../services/workshopsService.js';

export const workshopsRouter = Router();
workshopsRouter.use(requireAuth);

workshopsRouter.get('/', requirePermission(PermissionCode.MasterDataView), async (req, res) => {
  const activeOnly = String(req.query.activeOnly ?? '').toLowerCase() === 'true';
  const result = await listWorkshops({ activeOnly });
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
