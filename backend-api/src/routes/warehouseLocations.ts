import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  aggregateRegisterUsage,
  listWarehouseLocations,
  seedSystemLocations,
  softDeleteWarehouseLocation,
  upsertWarehouseLocation,
} from '../services/warehouseLocationsService.js';

export const warehouseLocationsRouter = Router();
warehouseLocationsRouter.use(requireAuth);

warehouseLocationsRouter.get('/', requirePermission(PermissionCode.WarehouseLocationsView), async (req, res) => {
  const type = String(req.query.type ?? '').trim() as 'system' | 'workshop' | 'regular' | '';
  const activeOnly = String(req.query.activeOnly ?? '').toLowerCase() === 'true';
  const result = await listWarehouseLocations({
    ...(type === 'system' || type === 'workshop' || type === 'regular' ? { type } : {}),
    activeOnly,
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseLocationsRouter.get(
  '/register-usage',
  requirePermission(PermissionCode.WarehouseLocationsView),
  async (_req, res) => {
    const result = await aggregateRegisterUsage();
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

warehouseLocationsRouter.post('/', requirePermission(PermissionCode.WarehouseLocationsManage), async (req, res) => {
  const schema = z.object({
    id: z.string().uuid().optional(),
    type: z.enum(['workshop', 'regular']),
    code: z.string().min(1),
    name: z.string().min(1),
    workshopId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
    metadataJson: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const result = await upsertWarehouseLocation({
    ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
    type: parsed.data.type,
    code: parsed.data.code,
    name: parsed.data.name,
    ...(parsed.data.workshopId !== undefined ? { workshopId: parsed.data.workshopId } : {}),
    ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
    ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
    ...(parsed.data.metadataJson !== undefined ? { metadataJson: parsed.data.metadataJson } : {}),
  });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

warehouseLocationsRouter.delete(
  '/:id',
  requirePermission(PermissionCode.WarehouseLocationsManage),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
    const result = await softDeleteWarehouseLocation({ id });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);

warehouseLocationsRouter.post(
  '/seed-system',
  requirePermission(PermissionCode.WarehouseLocationsManage),
  async (_req, res) => {
    const result = await seedSystemLocations();
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  },
);
