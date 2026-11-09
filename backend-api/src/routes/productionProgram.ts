import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { PermissionCode } from '../auth/permissions.js';
import { requirePermission } from '../auth/middleware.js';
import {
  createProductionProgram,
  deleteProductionProgram,
  getProductionProgram,
  listProductionPrograms,
  replaceProductionProgramRows,
  updateProductionProgram,
} from '../services/productionProgramService.js';

/**
 * Производственная программа (ПП) — REST-дверь модуля.
 *
 * Читать план может весь производственный контур (`production_program.view`),
 * вести — те, кому выдано `production_program.edit` (двигателист, мастер).
 * Клиентский push в эти таблицы закрыт безусловным backstop'ом (владение server) —
 * эта дверь единственный путь записи.
 */
export const productionProgramRouter = Router();

const programBody = z.object({
  periodStart: z.number(),
  periodEnd: z.number(),
  shop: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  status: z.enum(['draft', 'approved']).optional(),
  signatureSlots: z.string().nullable().optional(),
});

const lineBody = z.object({
  id: z.string().trim().nullable().optional(),
  orderNo: z.number(),
  contractId: z.string().trim().nullable().optional(),
  groupLabel: z.string().trim().min(1).max(300),
  contractKind: z.enum(['military', 'civil']).nullable().optional(),
  engineId: z.string().trim().nullable().optional(),
  engineMark: z.string().max(120).optional(),
  engineNumber: z.string().max(120).optional(),
  state: z.enum(['restoration', 'repairable', 'capital_repair']).nullable().optional(),
  shippingPlanAt: z.number().nullable().optional(),
  factors: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
});

productionProgramRouter.get('/', requirePermission(PermissionCode.ProductionProgramView), async (_req: Request, res: Response) => {
  const result = await listProductionPrograms();
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

productionProgramRouter.get('/:id', requirePermission(PermissionCode.ProductionProgramView), async (req: Request, res: Response) => {
  const result = await getProductionProgram(String(req.params.id ?? ''));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

productionProgramRouter.post('/', requirePermission(PermissionCode.ProductionProgramEdit), async (req: Request, res: Response) => {
  const parsed = programBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные программы', issues: parsed.error.issues });
  const result = await createProductionProgram(parsed.data);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

productionProgramRouter.patch('/:id', requirePermission(PermissionCode.ProductionProgramEdit), async (req: Request, res: Response) => {
  const parsed = programBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные данные программы', issues: parsed.error.issues });
  const result = await updateProductionProgram(String(req.params.id ?? ''), parsed.data);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

productionProgramRouter.put('/:id/rows', requirePermission(PermissionCode.ProductionProgramEdit), async (req: Request, res: Response) => {
  const parsed = z.object({ rows: z.array(lineBody) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'неверные строки плана', issues: parsed.error.issues });
  const result = await replaceProductionProgramRows(String(req.params.id ?? ''), parsed.data.rows);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

productionProgramRouter.delete('/:id', requirePermission(PermissionCode.ProductionProgramEdit), async (req: Request, res: Response) => {
  const result = await deleteProductionProgram(String(req.params.id ?? ''));
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});
