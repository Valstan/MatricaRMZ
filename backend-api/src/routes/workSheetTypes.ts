import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  archiveWorkSheetType,
  listWorkSheetTypes,
  restoreWorkSheetType,
  upsertWorkSheetType,
} from '../services/workSheetTypeService.js';

/**
 * Справочник видов работ для этапов. Читать может любой, кто видит операции (строки этапов работ
 * — записи истории ремонта под `operations.view`); заводить и править виды работ — отдельное
 * поимённое право `work_sheet_types.edit` (не то же, что заполнение строк `work_sheets.edit`).
 */
export const workSheetTypesRouter = Router();
workSheetTypesRouter.use(requireAuth);

workSheetTypesRouter.get('/', requirePermission(PermissionCode.OperationsView), async (req, res) => {
  const includeArchived = String(req.query.includeArchived ?? '') === '1';
  const result = await listWorkSheetTypes({ includeArchived });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

const columnSchema = z
  .object({
    code: z.string().optional(),
    label: z.string().min(1).max(120),
    type: z.string().optional(),
    required: z.boolean().optional(),
    options: z.array(z.string()).optional(),
  })
  .passthrough();

workSheetTypesRouter.post('/', requirePermission(PermissionCode.WorkSheetTypesEdit), async (req, res) => {
  const schema = z.object({
    id: z.string().optional(),
    code: z.string().max(40).optional(),
    name: z.string().min(1).max(120),
    workshopId: z.string().nullable().optional(),
    completesRepair: z.boolean().optional(),
    columns: z.array(columnSchema).optional(),
    sortOrder: z.number().int().optional(),
    // Узел, каким его видел редактор: не совпал — правил кто-то ещё, и набор колонок
    // затёрся бы целиком (сервис пишет columns_json одним куском).
    expectedUpdatedAt: z.number().int().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const actor = (req as AuthenticatedRequest).user?.username ?? null;
  const result = await upsertWorkSheetType({ ...parsed.data, actor });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

workSheetTypesRouter.post('/:id/archive', requirePermission(PermissionCode.WorkSheetTypesEdit), async (req, res) => {
  const actor = (req as AuthenticatedRequest).user?.username ?? null;
  const result = await archiveWorkSheetType(String(req.params.id ?? ''), actor);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

workSheetTypesRouter.post('/:id/restore', requirePermission(PermissionCode.WorkSheetTypesEdit), async (req, res) => {
  const actor = (req as AuthenticatedRequest).user?.username ?? null;
  const result = await restoreWorkSheetType(String(req.params.id ?? ''), actor);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});
